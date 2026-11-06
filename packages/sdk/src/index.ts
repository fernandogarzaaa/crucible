import { newId, renderTemplate, type ChatRequest, type ChatResponse, type Json, type Message, type PromptVersion, type Span, type SpanKind, type Trace, type Usage } from "@crucible/core";

export interface CrucibleOptions {
  /** Base URL of a running Crucible server, e.g. http://localhost:4800*/
  baseUrl?: string;
  apiKey?: string;
  project?: string;
  /** Flush interval for batched spans. */
  flushIntervalMs?: number;
  /** Custom transport (tests, or in-process embedding). */
  transport?: Transport;
  fetch?: typeof fetch;
}

export interface Transport {
  ingest(batch: { traces: Trace[]; spans: Span[] }): Promise<void>;
  getPrompt(project: string, ref: string): Promise<PromptVersion | undefined>;
  chat(project: string, req: ChatRequest): Promise<ChatResponse>;
}

class HttpTransport implements Transport {
  constructor(private baseUrl: string, private apiKey: string | undefined, private f: typeof fetch) {}
  private headers() { return { "content-type": "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) }; }
  async ingest(batch: { traces: Trace[]; spans: Span[] }) {
    const res = await this.f(`${this.baseUrl}/api/ingest`, { method: "POST", headers: this.headers(), body: JSON.stringify(batch) });
    if (!res.ok) throw new Error(`ingest failed: ${res.status}`);
  }
  async getPrompt(project: string, ref: string) {
    const res = await this.f(`${this.baseUrl}/api/projects/${encodeURIComponent(project)}/prompts/resolve?ref=${encodeURIComponent(ref)}`, { headers: this.headers() });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`prompt fetch failed: ${res.status}`);
    return (await res.json()) as PromptVersion;
  }
  async chat(project: string, req: ChatRequest) {
    const res = await this.f(`${this.baseUrl}/api/projects/${encodeURIComponent(project)}/chat`, { method: "POST", headers: this.headers(), body: JSON.stringify(req) });
    if (!res.ok) throw new Error(`chat failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as ChatResponse;
  }
}

export class SpanHandle {
  constructor(readonly span: Span, private readonly client: Crucible) {}
  get id() { return this.span.id; }
  setAttributes(attrs: Record<string, Json>) { Object.assign(this.span.attributes, attrs); return this; }
  setUsage(usage: Usage, model?: string) { this.span.usage = usage; if (model) this.span.model = model; return this; }
  end(patch: { output?: Json; error?: string; status?: Span["status"] } = {}) {
    this.span.endedAt = Date.now();
    if (patch.output !== undefined) this.span.output = patch.output;
    if (patch.error) { this.span.error = patch.error; this.span.status = "error"; } else this.span.status = patch.status ?? "ok";
    this.client.enqueueSpan(this.span);
    return this.span;
  }
  child(name: string, kind: SpanKind, input?: Json) { return this.client.startSpan(this.span.traceId, name, kind, input, this.span.id); }
}

export class TraceHandle {
  constructor(readonly trace: Trace, private readonly client: Crucible) {}
  get id() { return this.trace.id; }
  span(name: string, kind: SpanKind = "custom", input?: Json) { return this.client.startSpan(this.trace.id, name, kind, input, null); }
  end(patch: { output?: Json; error?: string; metadata?: Record<string, Json> } = {}) {
    this.trace.endedAt = Date.now();
    if (patch.output !== undefined) this.trace.output = patch.output;
    if (patch.metadata) Object.assign(this.trace.metadata, patch.metadata);
    this.trace.status = patch.error ? "error" : "ok";
    if (patch.error) this.trace.metadata.error = patch.error;
    this.client.enqueueTrace(this.trace);
    return this.trace;
  }
}

/**
 * Lightweight client: zero dependencies beyond core types, batched async export,
 * never throws into your application code on export failure.
 */
export class Crucible {
  readonly project: string;
  private readonly transport: Transport;
  private traces: Trace[] = [];
  private spans: Span[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private promptCache = new Map<string, { v: PromptVersion; at: number }>();
  onError: (err: unknown) => void = (e) => console.warn("[crucible] export failed:", (e as Error).message ?? e);

  constructor(opts: CrucibleOptions = {}) {
    this.project = opts.project ?? process.env.CRUCIBLE_PROJECT ?? "default";
    this.transport = opts.transport ?? new HttpTransport((opts.baseUrl ?? process.env.CRUCIBLE_URL ?? "http://localhost:4800").replace(/\/$/, ""), opts.apiKey ?? process.env.CRUCIBLE_API_KEY, opts.fetch ?? fetch);
    const interval = opts.flushIntervalMs ?? 2000;
    if (interval > 0) { this.timer = setInterval(() => void this.flush(), interval); (this.timer as { unref?: () => void }).unref?.(); }
  }

  trace(name: string, opts: { input?: Json; metadata?: Record<string, Json>; tags?: string[]; sessionId?: string; userId?: string } = {}): TraceHandle {
    const trace: Trace = { id: newId.trace(), projectId: this.project, name, status: "running", startedAt: Date.now(), endedAt: null, input: opts.input, output: undefined, metadata: opts.metadata ?? {}, tags: opts.tags ?? [], sessionId: opts.sessionId, userId: opts.userId, totalTokens: 0, costUsd: 0, spanCount: 0 };
    // Register the trace immediately so spans arriving first still attach to it.
    this.traces.push({ ...trace });
    return new TraceHandle(trace, this);
  }

  startSpan(traceId: string, name: string, kind: SpanKind, input: Json | undefined, parentSpanId: string | null): SpanHandle {
    const span: Span = { id: newId.span(), traceId, parentSpanId, name, kind, status: "running", startedAt: Date.now(), endedAt: null, input, output: undefined, attributes: {}, model: undefined, provider: undefined, usage: undefined, costUsd: undefined, error: undefined };
    return new SpanHandle(span, this);
  }

  /** Run a function inside a trace, recording output and errors. */
  async traced<T>(name: string, fn: (t: TraceHandle) => Promise<T>, opts: Parameters<Crucible["trace"]>[1] = {}): Promise<T> {
    const t = this.trace(name, opts);
    try { const out = await fn(t); t.end({ output: safeJson(out) }); return out; }
    catch (err) { t.end({ error: (err as Error).message }); throw err; }
  }

  /** Run a function inside a span. */
  async withSpan<T>(parent: TraceHandle | SpanHandle, name: string, kind: SpanKind, fn: (s: SpanHandle) => Promise<T>, input?: Json): Promise<T> {
    const s = parent instanceof TraceHandle ? parent.span(name, kind, input) : parent.child(name, kind, input);
    try { const out = await fn(s); s.end({ output: safeJson(out) }); return out; }
    catch (err) { s.end({ error: (err as Error).message }); throw err; }
  }

  /** Fetch a versioned prompt (`name`, `name@3`, `name@production`) with a 30s cache. */
  async prompt(ref: string, vars?: Record<string, unknown>): Promise<{ version: PromptVersion; messages: Message[] }> {
    const cached = this.promptCache.get(ref);
    const v = cached && Date.now() - cached.at < 30_000 ? cached.v : await this.transport.getPrompt(this.project, ref);
    if (!v) throw new Error(`prompt not found: ${ref}`);
    this.promptCache.set(ref, { v, at: Date.now() });
    return { version: v, messages: vars ? renderTemplate(v.template, vars) : v.template };
  }

  /** Call a model through the Crucible gateway (budgets, caching, fallback, tracing included). */
  chat(req: ChatRequest): Promise<ChatResponse> { return this.transport.chat(this.project, req); }

  enqueueSpan(s: Span) { this.spans.push(s); }
  enqueueTrace(t: Trace) { const i = this.traces.findIndex((x) => x.id === t.id); if (i >= 0) this.traces[i] = t; else this.traces.push(t); }

  async flush(): Promise<void> {
    if (!this.traces.length && !this.spans.length) return;
    const batch = { traces: this.traces, spans: this.spans };
    this.traces = []; this.spans = [];
    try { await this.transport.ingest(batch); } catch (err) { this.onError(err); }
  }

  async shutdown(): Promise<void> { if (this.timer) clearInterval(this.timer); await this.flush(); }
}

function safeJson(v: unknown): Json {
  try { return JSON.parse(JSON.stringify(v ?? null)) as Json; } catch { return String(v); }
}

export type { Trace, Span, SpanKind, PromptVersion, Message, ChatRequest, ChatResponse } from "@crucible/core";
