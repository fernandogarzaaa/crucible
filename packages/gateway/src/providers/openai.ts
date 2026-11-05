import type { ChatRequest, ChatResponse, ContentPart, Message, Usage } from "@crucible/core";
import { ProviderError, isRetryableStatus, type Provider, type StreamEvent } from "../types.js";
import { parseSse } from "./sse.js";

export interface OpenAIOptions {
  /** Provider name used in routes, e.g. "openai", "groq", "together", "ollama". */
  name?: string;
  apiKey?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  models?: string[];
  /** Predicate deciding which model ids this provider claims. */
  supportsModel?: (model: string) => boolean;
}

const DEFAULT_MODELS = ["gpt-4.1", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini", "o3", "o4-mini", "text-embedding-3-small", "text-embedding-3-large"];

function toOpenAI(req: ChatRequest): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];
  for (const m of req.messages) {
    if (typeof m.content === "string") { messages.push({ role: m.role === "tool" ? "user" : m.role, content: m.content, name: m.name }); continue; }
    const text: Array<Record<string, unknown>> = [];
    const toolCalls: Array<Record<string, unknown>> = [];
    for (const p of m.content) {
      if (p.type === "text") text.push({ type: "text", text: p.text });
      else if (p.type === "image") text.push({ type: "image_url", image_url: { url: `data:${p.mediaType};base64,${p.data}` } });
      else if (p.type === "tool_use") toolCalls.push({ id: p.id, type: "function", function: { name: p.name, arguments: JSON.stringify(p.input) } });
      else if (p.type === "tool_result") messages.push({ role: "tool", tool_call_id: p.toolUseId, content: p.content });
    }
    if (text.length || toolCalls.length) {
      const msg: Record<string, unknown> = { role: m.role === "tool" ? "user" : m.role };
      if (text.length) msg.content = text.length === 1 && text[0]!.type === "text" ? text[0]!.text : text;
      else msg.content = null;
      if (toolCalls.length) msg.tool_calls = toolCalls;
      messages.push(msg);
    }
  }
  const c = req.config;
  const body: Record<string, unknown> = { model: c.model, messages, stream: req.stream ?? false };
  if (c.maxTokens !== undefined) body.max_completion_tokens = c.maxTokens;
  if (c.temperature !== undefined) body.temperature = c.temperature;
  if (c.topP !== undefined) body.top_p = c.topP;
  if (c.stopSequences?.length) body.stop = c.stopSequences;
  if (c.responseFormat === "json") body.response_format = { type: "json_object" };
  if (c.tools?.length) {
    body.tools = c.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
    if (c.toolChoice === "required") body.tool_choice = "required";
    else if (c.toolChoice === "none") body.tool_choice = "none";
    else if (typeof c.toolChoice === "object") body.tool_choice = { type: "function", function: { name: c.toolChoice.name } };
  }
  if (req.stream) body.stream_options = { include_usage: true };
  return body;
}

const fromFinish = (f: string | null | undefined): ChatResponse["stopReason"] =>
  f === "length" ? "max_tokens" : f === "tool_calls" ? "tool_use" : f === "stop" ? "end_turn" : "end_turn";

const usageFrom = (u: Record<string, any> | undefined): Usage => ({
  inputTokens: u?.prompt_tokens ?? 0, outputTokens: u?.completion_tokens ?? 0, cacheReadTokens: u?.prompt_tokens_details?.cached_tokens,
});

export class OpenAICompatibleProvider implements Provider {
  readonly name: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly f: typeof fetch;
  private readonly modelList: string[];
  private readonly supportsFn: (m: string) => boolean;

  constructor(opts: OpenAIOptions = {}) {
    this.name = opts.name ?? "openai";
    this.apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY ?? "";
    this.baseUrl = (opts.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.f = opts.fetch ?? fetch;
    this.modelList = opts.models ?? DEFAULT_MODELS;
    this.supportsFn = opts.supportsModel ?? ((m) => this.modelList.includes(m) || /^(gpt-|o\d|text-embedding)/.test(m));
  }
  models() { return this.modelList; }
  supports(model: string) { return this.supportsFn(model); }

  private async post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const res = await this.f(`${this.baseUrl}${path}`, { method: "POST", signal, headers, body: JSON.stringify(body) });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ProviderError(`${this.name} ${res.status}: ${text.slice(0, 500)}`, this.name, res.status, isRetryableStatus(res.status));
    }
    return res;
  }

  async chat(req: ChatRequest, signal?: AbortSignal) {
    const res = await this.post("/chat/completions", { ...toOpenAI(req), stream: false }, signal);
    const data = (await res.json()) as any;
    const choice = data.choices?.[0];
    const parts: ContentPart[] = [];
    if (choice?.message?.content) parts.push({ type: "text", text: choice.message.content });
    for (const tc of choice?.message?.tool_calls ?? []) {
      let input: unknown = {};
      try { input = JSON.parse(tc.function?.arguments || "{}"); } catch { input = { _raw: tc.function?.arguments }; }
      parts.push({ type: "tool_use", id: tc.id, name: tc.function?.name, input });
    }
    const message: Message = { role: "assistant", content: parts };
    return { id: data.id ?? "", model: data.model ?? req.config.model, provider: this.name, message, stopReason: fromFinish(choice?.finish_reason), usage: usageFrom(data.usage) };
  }

  async *stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const res = await this.post("/chat/completions", { ...toOpenAI(req), stream: true }, signal);
    let text = "";
    const tools = new Map<number, { id: string; name: string; args: string }>();
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let stop: ChatResponse["stopReason"] = "end_turn";
    let started = false;
    for await (const ev of parseSse(res)) {
      const d = ev.data as any;
      if (!d || typeof d !== "object") continue;
      if (!started) { started = true; yield { type: "start", id: d.id ?? "", model: d.model ?? req.config.model }; }
      if (d.usage) { usage = usageFrom(d.usage); yield { type: "usage", usage }; }
      const choice = d.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      if (typeof delta.content === "string" && delta.content) { text += delta.content; yield { type: "text_delta", text: delta.content }; }
      for (const tc of delta.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        let t = tools.get(idx);
        if (!t) { t = { id: tc.id ?? `call_${idx}`, name: tc.function?.name ?? "", args: "" }; tools.set(idx, t); yield { type: "tool_use_start", id: t.id, name: t.name }; }
        if (tc.function?.arguments) { t.args += tc.function.arguments; yield { type: "tool_use_delta", id: t.id, inputJsonDelta: tc.function.arguments }; }
      }
      if (choice.finish_reason) stop = fromFinish(choice.finish_reason);
    }
    const parts: ContentPart[] = [];
    if (text) parts.push({ type: "text", text });
    for (const t of tools.values()) {
      let input: unknown = {};
      try { input = JSON.parse(t.args || "{}"); } catch { input = { _raw: t.args }; }
      parts.push({ type: "tool_use", id: t.id, name: t.name, input });
      yield { type: "tool_use_end", id: t.id };
    }
    yield { type: "end", stopReason: stop, message: { role: "assistant", content: parts }, usage };
  }

  async embed(model: string, inputs: string[], signal?: AbortSignal) {
    const res = await this.post("/embeddings", { model, input: inputs }, signal);
    const data = (await res.json()) as any;
    const embeddings = (data.data as Array<{ index: number; embedding: number[] }>).sort((a, b) => a.index - b.index).map((d) => d.embedding);
    return { embeddings, usage: { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: 0 } };
  }
}
