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
    const proto = await app.request("/v1/traces", { method: "POST", headers: { "content-type": "application/x-protobuf" }, body: "" });
    expect(proto.status).toBe(415);
  });
  it("classifies operations", () => {
    expect(kindFromOperation("embeddings", "x")).toBe("embedding");
    expect(kindFromOperation("invoke_workflow", "x")).toBe("chain");
    expect(kindFromOperation(undefined, "vector search")).toBe("retriever");
  });
});
