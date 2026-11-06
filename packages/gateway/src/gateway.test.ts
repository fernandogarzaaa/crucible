import { describe, expect, it } from "vitest";
import { Store } from "@crucible/core";
import { Gateway, GatewayError } from "./gateway.js";
import { MockProvider } from "./providers/mock.js";
import { Router } from "./router.js";
import { redactText } from "./redact.js";
import { MemoryCache } from "./cache.js";

const ask = (model: string, text = "hello") => ({ messages: [{ role: "user" as const, content: text }], config: { model } });

describe("Gateway", () => {
  it("routes with fallback when the primary fails", async () => {
    const flaky = new MockProvider({ name: "flaky", failFirst: 5, models: ["mock-a"] });
    const steady = new MockProvider({ name: "steady", models: ["mock-b"] });
    const store = Store.memory();
    const p = store.workbench.ensureDefaultProject();
    const router = new Router([flaky, steady], { routes: [{ name: "smart", strategy: "fallback", targets: [{ provider: "flaky", model: "mock-a" }, { provider: "steady", model: "mock-b" }] }] });
    const gw = new Gateway({ providers: [flaky, steady], router, store, retriesPerTarget: 1 });
    const res = await gw.chat(ask("smart"), { projectId: p.id });
    expect(res.provider).toBe("steady");
    expect(res.message.content).toBe("echo: hello");
    const log = store.gateway.list(p.id);
    expect(log.filter((r) => r.status >= 500)).toHaveLength(2); // one try + one retry on flaky
    expect(log.find((r) => r.status === 200)?.fallbackDepth).toBe(1);
  });

  it("caches identical requests and records zero cost", async () => {
    const m = new MockProvider();
    const store = Store.memory();
    const p = store.workbench.ensureDefaultProject();
    const gw = new Gateway({ providers: [m], store, defaultCacheTtlSeconds: 60, cache: new MemoryCache() });
    const a = await gw.chat(ask("mock-fast"), { projectId: p.id });
    const b = await gw.chat(ask("mock-fast"), { projectId: p.id });
    expect(a.cached).toBe(false);
    expect(b.cached).toBe(true);
    expect(m.calls).toBe(1);
    expect(store.gateway.stats(p.id, 60_000).cached).toBe(1);
  });

  it("blocks when a hard budget is exceeded", async () => {
    const store = Store.memory();
    const p = store.workbench.ensureDefaultProject();
    store.gateway.setBudget({ projectId: p.id, scope: "project", limitUsd: 0.000001, period: "total" });
    store.gateway.record({ projectId: p.id, apiKeyId: null, requestedModel: "x", servedModel: "x", provider: "mock", route: "direct", status: 200, cached: false, fallbackDepth: 0, latencyMs: 1, usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0.01, traceId: null, error: null });
    const gw = new Gateway({ providers: [new MockProvider()], store });
    await expect(gw.chat(ask("mock-fast"), { projectId: p.id })).rejects.toMatchObject({ code: "budget_exceeded", status: 402 } satisfies Partial<GatewayError>);
  });

  it("rate limits per key", async () => {
    const gw = new Gateway({ providers: [new MockProvider()], rateLimitPerMinute: 2 });
    await gw.chat(ask("mock-fast"), { projectId: "p" });
    await gw.chat(ask("mock-fast"), { projectId: "p" });
    await expect(gw.chat(ask("mock-fast"), { projectId: "p" })).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("redacts PII on routes that ask for it", async () => {
    const m = new MockProvider({ reply: (req) => `saw: ${typeof req.messages[0]!.content === "string" ? req.messages[0]!.content : ""}` });
    const router = new Router([m], { routes: [{ name: "safe", strategy: "fallback", redact: true, targets: [{ provider: "mock", model: "mock-fast" }] }] });
    const gw = new Gateway({ providers: [m], router });
    const res = await gw.chat(ask("safe", "mail ada@example.com, card 4111 1111 1111 1111"), { projectId: "p" });
    expect(res.message.content).toBe("saw: mail [EMAIL], card [CARD]");
    expect(redactText("call 555-123-4567")).toBe("call [PHONE]");
  });

  it("streams and falls back before first token", async () => {
    const flaky = new MockProvider({ name: "flaky", failFirst: 1 });
    const steady = new MockProvider({ name: "steady", reply: () => "one two three" });
    const router = new Router([flaky, steady], { routes: [{ name: "s", strategy: "fallback", targets: [{ provider: "flaky", model: "mock-a" }, { provider: "steady", model: "mock-b" }] }] });
    const gw = new Gateway({ providers: [flaky, steady], router });
    let text = "";
    let ended = false;
    for await (const ev of gw.stream(ask("s"), { projectId: "p" })) {
      if (ev.type === "text_delta") text += ev.text;
      if (ev.type === "end") ended = true;
    }
    expect(text).toBe("one two three");
    expect(ended).toBe(true);
  });

  it("supports provider/model pinning and cheapest strategy", () => {
    const a = new MockProvider({ name: "a" });
    const b = new MockProvider({ name: "b" });
    const router = new Router([a, b], { routes: [{ name: "cheap", strategy: "cheapest", targets: [{ provider: "a", model: "claude-sonnet-5-5" }, { provider: "b", model: "claude-haiku-5-5" }] }] });
    expect(router.resolve("b/mock-x").attempts[0]?.provider.name).toBe("b");
    // A pin to a provider that does not exist fails even when a default route is configured.
    const withDefault = new Router([a, b], { routes: [{ name: "cheap", strategy: "fallback", targets: [{ provider: "a", model: "m" }] }], defaultRoute: "cheap" });
    expect(() => withDefault.resolve("nope/m")).toThrow(/unknown provider "nope"/);
    expect(withDefault.resolve("totally-unknown-model").route?.name).toBe("cheap");
    expect(router.resolve("cheap").attempts.map((t) => t.model)).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5"]);
  });
});
