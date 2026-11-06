import { describe, expect, it } from "vitest";
import { Store } from "@crucible/core";
import { MockProvider } from "@crucible/gateway";
import { createApp, createContext } from "./app.js";
import { kindFromOperation } from "./otlp.js";

const ns = (ms: number) => String(ms * 1_000_000);
const kv = (key: string, value: unknown) => ({ key, value: typeof value === "number" ? { intValue: String(value) } : typeof value === "boolean" ? { boolValue: value } : { stringValue: String(value) } });

describe("OTLP ingest", () => {
  it("maps gen_ai.* spans onto traces with cost and content", async () => {
    const ctx = createContext({ store: Store.memory(), providers: [new MockProvider()], registerDemoAgents: false, loadUserAgents: false });
    const app = createApp(ctx, { quiet: true });
    const t0 = Date.now() - 1000;
    const body = { resourceSpans: [{ resource: { attributes: [kv("service.name", "support-bot")] }, scopeSpans: [{ scope: { name: "opentelemetry.instrumentation.anthropic" }, schemaUrl: "https://opentelemetry.io/schemas/gen-ai/1.42.0", spans: [
      { traceId: "abc123", spanId: "s1", name: "invoke_agent triage", kind: 1, startTimeUnixNano: ns(t0), endTimeUnixNano: ns(t0 + 900), attributes: [kv("gen_ai.operation.name", "invoke_agent"), kv("gen_ai.agent.name", "triage"), kv("gen_ai.conversation.id", "conv-7")], status: { code: 1 } },
      { traceId: "abc123", spanId: "s2", parentSpanId: "s1", name: "chat claude-haiku-5-5", kind: 3, startTimeUnixNano: ns(t0 + 10), endTimeUnixNano: ns(t0 + 500), attributes: [kv("gen_ai.operation.name", "chat"), kv("gen_ai.provider.name", "anthropic"), kv("gen_ai.request.model", "claude-haiku-5-5"), kv("gen_ai.usage.input_tokens", 1000), kv("gen_ai.usage.output_tokens", 100), kv("gen_ai.input.messages", JSON.stringify([{ role: "user", parts: [{ type: "text", content: "hi" }] }]))], status: { code: 1 } },
      { traceId: "abc123", spanId: "s3", parentSpanId: "s1", name: "execute_tool lookup", kind: 1, startTimeUnixNano: ns(t0 + 510), endTimeUnixNano: ns(t0 + 800), attributes: [kv("gen_ai.operation.name", "execute_tool"), kv("gen_ai.tool.name", "lookup"), kv("gen_ai.tool.call.arguments", "{\"q\":1}"), kv("error.type", "TimeoutError")], status: { code: 2, message: "timed out" } },
    ] }] }] };
    const res = await app.request("/v1/traces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { crucible: { spans: number } };
    expect(out.crucible.spans).toBe(3);
    const trace = ctx.store.tracing.getTrace("tr_otel_abc123")!;
    expect(trace.status).toBe("error");
    expect(trace.sessionId).toBe("conv-7");
    expect(trace.spanCount).toBe(3);
    expect(trace.costUsd).toBeGreaterThan(0);
    const spans = ctx.store.tracing.listSpans(trace.id);
    expect(spans.map((s) => s.kind)).toEqual(["agent", "llm", "tool"]);
    expect(spans[1]!.input).toEqual([{ role: "user", parts: [{ type: "text", content: "hi" }] }]);
    expect(spans[1]!.attributes["otel.schema_url"]).toContain("1.42.0");
    expect(spans[2]!.error).toBe("timed out");
    expect(spans[2]!.input).toEqual({ q: 1 });
  });
  it("classifies operations", () => {
    expect(kindFromOperation("embeddings", "x")).toBe("embedding");
    expect(kindFromOperation("invoke_workflow", "x")).toBe("chain");
    expect(kindFromOperation(undefined, "vector search")).toBe("retriever");
  });
});

// ---- protobuf path: encode a request by hand with the same wire rules the decoder reads.
function varint(n: bigint | number): number[] { let v = BigInt(n); const out: number[] = []; do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v); return out; }
function ld(field: number, bytes: number[] | Uint8Array): number[] { return [...varint((field << 3) | 2), ...varint(bytes.length), ...bytes]; }
function str(field: number, s: string) { return ld(field, [...new TextEncoder().encode(s)]); }
function f64(field: number, n: bigint) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return [...varint((field << 3) | 1), ...b]; }
function vi(field: number, n: number | bigint) { return [...varint(field << 3), ...varint(n)]; }

describe("OTLP protobuf ingest", () => {
  it("decodes a binary ExportTraceServiceRequest", async () => {
    const ctx = createContext({ store: Store.memory(), providers: [new MockProvider()], registerDemoAgents: false, loadUserAgents: false });
    const app = createApp(ctx, { quiet: true });
    const t0 = BigInt(Date.now() - 500) * 1_000_000n;
    const keyValue = (k: string, inner: number[]) => [...str(1, k), ...ld(2, inner)];
    const spanBytes = [
      ...ld(1, [0xab, 0xcd, 0xef, 0x01]), ...ld(2, [0x00, 0x11]), ...str(5, "chat gpt-4.1"), ...vi(6, 3),
      ...f64(7, t0), ...f64(8, t0 + 250_000_000n),
      ...ld(9, keyValue("gen_ai.operation.name", str(1, "chat"))),
      ...ld(9, keyValue("gen_ai.provider.name", str(1, "openai"))),
      ...ld(9, keyValue("gen_ai.request.model", str(1, "gpt-4.1"))),
      ...ld(9, keyValue("gen_ai.usage.input_tokens", vi(3, 500))),
      ...ld(9, keyValue("gen_ai.usage.output_tokens", vi(3, 50))),
      ...ld(9, keyValue("gen_ai.output.messages", str(1, JSON.stringify([{ role: "assistant", parts: [{ type: "text", content: "pong" }] }])))),
      ...ld(15, [...vi(3, 1)]),
    ];
    const scopeSpans = [...ld(1, str(1, "my-instrumentation")), ...ld(2, spanBytes), ...str(3, "https://opentelemetry.io/schemas/gen-ai/1.42.0")];
    const resourceSpans = [...ld(1, ld(1, keyValue("service.name", str(1, "proto-svc")))), ...ld(2, scopeSpans)];
    const request = new Uint8Array(ld(1, resourceSpans));
    const res = await app.request("/v1/traces", { method: "POST", headers: { "content-type": "application/x-protobuf" }, body: request });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("protobuf");
    expect(res.headers.get("x-crucible-spans")).toBe("1");
    const trace = ctx.store.tracing.getTrace("tr_otel_abcdef01")!;
    expect(trace.status).toBe("ok");
    const [span] = ctx.store.tracing.listSpans(trace.id);
    expect(span!.id).toBe("sp_otel_0011");
    expect(span!.kind).toBe("llm");
    expect(span!.model).toBe("gpt-4.1");
    expect(span!.provider).toBe("openai");
    expect(span!.usage).toEqual({ inputTokens: 500, outputTokens: 50, cacheReadTokens: undefined });
    expect(span!.costUsd).toBeGreaterThan(0);
    expect(span!.output).toEqual([{ role: "assistant", parts: [{ type: "text", content: "pong" }] }]);
    expect(span!.endedAt! - span!.startedAt).toBe(250);
    expect(span!.attributes["service.name"]).toBe("proto-svc");
    const bad = await app.request("/v1/traces", { method: "POST", headers: { "content-type": "application/x-protobuf" }, body: new Uint8Array([0x0a, 0xff, 0xff]) });
    expect(bad.status).toBe(400);
  });
});
