import type { Json, Span, SpanKind, Store, Usage } from "@crucible/core";

/**
 * OTLP/JSON trace ingestion mapped onto Crucible spans using the OpenTelemetry GenAI semantic
 * conventions (gen_ai.* attributes). The conventions are still unreleased and in flux, so the
 * mapping is tolerant: it accepts both the current names (gen_ai.provider.name, gen_ai.input.messages)
 * and the older ones (gen_ai.system, gen_ai.prompt / gen_ai.completion). The scope schemaUrl, when
 * present, is stored on the span as `otel.schema_url` so history survives attribute renames.
 */

type OtlpValue = { stringValue?: string; intValue?: string | number; doubleValue?: number; boolValue?: boolean; arrayValue?: { values: OtlpValue[] }; kvlistValue?: { values: OtlpKv[] }; bytesValue?: string };
type OtlpKv = { key: string; value: OtlpValue };
interface OtlpSpan { traceId: string; spanId: string; parentSpanId?: string; name: string; kind?: number; startTimeUnixNano: string | number; endTimeUnixNano?: string | number; attributes?: OtlpKv[]; status?: { code?: number; message?: string }; events?: Array<{ name: string; timeUnixNano?: string; attributes?: OtlpKv[] }> }
export interface OtlpExportRequest { resourceSpans?: Array<{ resource?: { attributes?: OtlpKv[] }; scopeSpans?: Array<{ scope?: { name?: string; version?: string }; schemaUrl?: string; spans?: OtlpSpan[] }> }> }

function decode(v: OtlpValue | undefined): Json {
  if (!v) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.arrayValue) return v.arrayValue.values.map(decode);
  if (v.kvlistValue) return Object.fromEntries(v.kvlistValue.values.map((kv) => [kv.key, decode(kv.value)]));
  if (v.bytesValue !== undefined) return v.bytesValue;
  return null;
}
const attrs = (list: OtlpKv[] | undefined): Record<string, Json> => Object.fromEntries((list ?? []).map((kv) => [kv.key, decode(kv.value)]));
const nanoToMs = (n: string | number | undefined): number | null => (n === undefined ? null : Math.round(Number(n) / 1_000_000));
const maybeJson = (v: Json): Json => { if (typeof v !== "string") return v; try { return JSON.parse(v) as Json; } catch { return v; } };

export function kindFromOperation(op: string | undefined, name: string): SpanKind {
  const o = (op ?? "").toLowerCase();
  if (["chat", "text_completion", "generate_content", "completion"].includes(o)) return "llm";
  if (o === "embeddings" || o === "embed") return "embedding";
  if (o === "execute_tool") return "tool";
  if (o === "retrieval" || o === "retrieve") return "retriever";
  if (o === "invoke_agent" || o === "create_agent") return "agent";
  if (o === "invoke_workflow" || o === "plan") return "chain";
  const n = name.toLowerCase();
  if (/^(chat|completion|generate)/.test(n)) return "llm";
  if (/tool/.test(n)) return "tool";
  if (/retriev|search/.test(n)) return "retriever";
  if (/agent/.test(n)) return "agent";
  return "custom";
}

function toSpan(s: OtlpSpan, resource: Record<string, Json>, schemaUrl: string | undefined, scopeName: string | undefined): Span {
  const a = attrs(s.attributes);
  const str = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : undefined);
  const num = (k: string) => (typeof a[k] === "number" ? (a[k] as number) : undefined);
  const op = str("gen_ai.operation.name");
  const kind = kindFromOperation(op, s.name);
  const model = str("gen_ai.response.model") ?? str("gen_ai.request.model");
  const provider = str("gen_ai.provider.name") ?? str("gen_ai.system");
  const inTok = num("gen_ai.usage.input_tokens") ?? num("gen_ai.usage.prompt_tokens");
  const outTok = num("gen_ai.usage.output_tokens") ?? num("gen_ai.usage.completion_tokens");
  const usage: Usage | undefined = inTok !== undefined || outTok !== undefined ? { inputTokens: inTok ?? 0, outputTokens: outTok ?? 0, cacheReadTokens: num("gen_ai.usage.cache_read.input_tokens") } : undefined;
  // Content: opt-in attributes in the spec. Also harvest the operation.details event if content was emitted there.
  const detailsEvent = (s.events ?? []).find((e) => e.name === "gen_ai.client.inference.operation.details");
  const ev = attrs(detailsEvent?.attributes);
  let input: Json = maybeJson(a["gen_ai.input.messages"] ?? ev["gen_ai.input.messages"] ?? a["gen_ai.prompt"] ?? a["gen_ai.tool.call.arguments"] ?? null);
  let output: Json = maybeJson(a["gen_ai.output.messages"] ?? ev["gen_ai.output.messages"] ?? a["gen_ai.completion"] ?? a["gen_ai.tool.call.result"] ?? null);
  if (kind === "retriever") { input = input ?? a["gen_ai.retrieval.query"] ?? null; output = output ?? a["gen_ai.retrieval.documents"] ?? null; }
  const error = s.status?.code === 2 ? (s.status.message || str("error.type") || "error") : undefined;
  const attributes: Record<string, Json> = { ...a };
  if (schemaUrl) attributes["otel.schema_url"] = schemaUrl;
  if (scopeName) attributes["otel.scope"] = scopeName;
  if (resource["service.name"] !== undefined) attributes["service.name"] = resource["service.name"];
  for (const k of ["gen_ai.input.messages", "gen_ai.output.messages", "gen_ai.prompt", "gen_ai.completion"]) delete attributes[k];
  const started = nanoToMs(s.startTimeUnixNano) ?? Date.now();
  const ended = nanoToMs(s.endTimeUnixNano);
  const toolName = str("gen_ai.tool.name");
  const name = kind === "tool" && toolName ? `tool: ${toolName}` : s.name;
  return {
    id: `sp_otel_${s.spanId}`, traceId: `tr_otel_${s.traceId}`, parentSpanId: s.parentSpanId ? `sp_otel_${s.parentSpanId}` : null, name, kind,
    status: error ? "error" : ended ? "ok" : "running", startedAt: started, endedAt: ended, input: input ?? undefined, output: output ?? undefined,
    attributes, model, provider, usage, costUsd: undefined, error,
  };
}

export function ingestOtlp(store: Store, projectId: string, body: OtlpExportRequest): { traces: number; spans: number; schemaUrls: string[] } {
  const spans: Span[] = [];
  const schemaUrls = new Set<string>();
  const traceMeta = new Map<string, { sessionId?: string; userId?: string; service?: string; name?: string }>();
  for (const rs of body.resourceSpans ?? []) {
    const resource = attrs(rs.resource?.attributes);
    for (const ss of rs.scopeSpans ?? []) {
      if (ss.schemaUrl) schemaUrls.add(ss.schemaUrl);
      for (const raw of ss.spans ?? []) {
        const span = toSpan(raw, resource, ss.schemaUrl, ss.scope?.name);
        spans.push(span);
        const a = attrs(raw.attributes);
        const meta = traceMeta.get(span.traceId) ?? {};
        if (typeof a["gen_ai.conversation.id"] === "string") meta.sessionId = a["gen_ai.conversation.id"] as string;
        if (typeof a["session.id"] === "string") meta.sessionId ??= a["session.id"] as string;
        if (typeof a["user.id"] === "string" || typeof a["enduser.id"] === "string") meta.userId = (a["user.id"] ?? a["enduser.id"]) as string;
        if (typeof resource["service.name"] === "string") meta.service = resource["service.name"] as string;
        if (!raw.parentSpanId) meta.name = span.name;
        traceMeta.set(span.traceId, meta);
      }
    }
  }
  const { estimateCost } = storeHelpers;
  let traces = 0;
  store.db.transaction(() => {
    for (const [traceId, meta] of traceMeta) {
      if (!store.tracing.getTrace(traceId)) {
        const first = spans.filter((s) => s.traceId === traceId).sort((x, y) => x.startedAt - y.startedAt)[0]!;
        store.tracing.startTrace({ id: traceId, projectId, name: meta.name ?? first.name, startedAt: first.startedAt, sessionId: meta.sessionId, userId: meta.userId, metadata: { source: "otlp", service: meta.service ?? null }, tags: ["otlp"] });
        traces++;
      }
    }
    for (const s of spans) {
      if (s.usage && s.model) s.costUsd = estimateCost(s.model, s.usage);
      store.tracing.recordSpan(s);
    }
    for (const traceId of traceMeta.keys()) {
      const all = store.tracing.listSpans(traceId);
      const roots = all.filter((s) => !s.parentSpanId);
      const ended = all.every((s) => s.endedAt !== null);
      if (ended && all.length) {
        const root = roots[0] ?? all[0]!;
        store.tracing.endTrace(traceId, { status: all.some((s) => s.status === "error") ? "error" : "ok", output: root.output, endedAt: Math.max(...all.map((s) => s.endedAt ?? 0)) });
      }
    }
  });
  return { traces, spans: spans.length, schemaUrls: [...schemaUrls] };
}

// Indirection keeps estimateCost import lazy for tree-shaking in tests that stub core.
import { estimateCost as _estimateCost } from "@crucible/core";
const storeHelpers = { estimateCost: _estimateCost };
