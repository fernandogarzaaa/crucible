import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve, type ServerType } from "@hono/node-server";
import { Store } from "@crucible/core";
import { ClaudeCodeProvider, ClineProvider, CodexProvider, Gateway, MockProvider, OpenCodeProvider, Router, capture, which } from "@crucible/gateway";
import { createApp, createContext } from "./app.js";

/**
 * Live tests against the real vendor CLIs. Opt in with CRUCIBLE_LIVE_CLI=1 (each CLI is skipped when
 * not installed). Codex, OpenCode and Cline are pointed at an in-process Crucible server, so the full
 * path is exercised without any account: Crucible gateway -> CLI provider -> vendor CLI -> Crucible
 * compat endpoint -> mock model. CRUCIBLE_LIVE_CLAUDE=1 additionally calls Claude Code with the
 * signed-in subscription (spends a little quota).
 */
const live = process.env.CRUCIBLE_LIVE_CLI === "1";
let server: ServerType;
let base = "";
const work = mkdtempSync(join(tmpdir(), "crucible-live-"));

beforeAll(async () => {
  if (!live) return;
  const ctx = createContext({ store: Store.memory(), providers: [new MockProvider({ reply: () => "pong from crucible" })], registerDemoAgents: false, loadUserAgents: false });
  const app = createApp(ctx, { quiet: true });
  await new Promise<void>((resolve) => { server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => { base = `http://127.0.0.1:${info.port}`; resolve(); }); });
});
afterAll(() => { server?.close(); });

const ask = (model: string) => ({ messages: [{ role: "user" as const, content: "Reply with exactly the word pong." }], config: { model } });
const viaGateway = (p: InstanceType<typeof CodexProvider | typeof OpenCodeProvider | typeof ClineProvider | typeof ClaudeCodeProvider>) => new Gateway({ providers: [p], router: new Router([p]) });

describe.skipIf(!live || !which("codex"))("live: Codex CLI -> Crucible /v1/responses", () => {
  it("answers through the real codex binary", async () => {
    mkdirSync(join(work, "codex-home"), { recursive: true });
    const codex = new CodexProvider({ timeoutMs: 120_000, env: { CRUCIBLE_KEY: "local", CODEX_HOME: join(work, "codex-home") }, config: ['model_provider="crucible"', `model_providers.crucible={name="Crucible",base_url="${base}/v1",env_key="CRUCIBLE_KEY",wire_api="responses"}`] });
    const res = await viaGateway(codex).chat(ask("codex/mock-fast"), { projectId: "p" });
    expect(res.provider).toBe("codex");
    expect(String(res.message.content).trim()).toBe("pong from crucible");
    expect(res.usage.inputTokens).toBeGreaterThan(0);
  }, 180_000);
});

describe.skipIf(!live || !which("opencode"))("live: OpenCode CLI -> Crucible /v1/chat/completions", () => {
  it("answers through the real opencode binary", async () => {
    const cfg = join(work, "opencode.json");
    writeFileSync(cfg, JSON.stringify({ provider: { crucible: { npm: "@ai-sdk/openai-compatible", name: "Crucible", options: { baseURL: `${base}/v1`, apiKey: "local" }, models: { "mock-fast": { name: "mock-fast" } } } } }));
    const oc = new OpenCodeProvider({ timeoutMs: 180_000, configPath: cfg });
    const res = await viaGateway(oc).chat(ask("opencode/crucible/mock-fast"), { projectId: "p" });
    expect(res.provider).toBe("opencode");
    expect(String(res.message.content).trim()).toBe("pong from crucible");
  }, 240_000);
});

describe.skipIf(!live || !which("cline"))("live: Cline CLI -> Crucible /v1/chat/completions", () => {
  it("answers through the real cline binary", async () => {
    const dataDir = join(work, "cline-data");
    const auth = await capture("cline", ["auth", "-p", "openai-compatible", "-b", `${base}/v1`, "-k", "local", "-m", "mock-fast", "--data-dir", dataDir], { timeoutMs: 60_000 });
    expect(auth.code).toBe(0);
    const cl = new ClineProvider({ timeoutMs: 180_000, dataDir });
    const res = await viaGateway(cl).chat(ask("cline/openai-compatible/mock-fast"), { projectId: "p" });
    expect(res.provider).toBe("cline");
    expect(String(res.message.content).trim()).toBe("pong from crucible");
  }, 240_000);
});

describe.skipIf(!live || process.env.CRUCIBLE_LIVE_CLAUDE !== "1" || !which("claude"))("live: Claude Code with the signed-in subscription", () => {
  it("answers through the real claude binary, streaming", async () => {
    const gw = viaGateway(new ClaudeCodeProvider({ timeoutMs: 120_000 }));
    let text = "";
    for await (const ev of gw.stream(ask("claude-code/haiku"), { projectId: "p" })) if (ev.type === "text_delta") text += ev.text;
    expect(text.trim().toLowerCase()).toContain("pong");
  }, 180_000);
});
