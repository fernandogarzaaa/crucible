import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ChatRequest } from "@crucible/core";
import { Gateway } from "../../gateway.js";
import { Router } from "../../router.js";
import { MockProvider } from "../mock.js";
import { ClaudeCodeProvider } from "./claude-code.js";
import { ClineProvider } from "./cline.js";
import { CodexProvider } from "./codex.js";
import { OpenCodeProvider } from "./opencode.js";
import { renderTranscript } from "./base.js";
import { buildFreeRoute } from "./free.js";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, "fake-cli.mjs");
const fx = (n: string) => join(here, "__fixtures__", n);
const ask = (model: string, text = "Reply with exactly: one two three", extra: Partial<ChatRequest> = {}): ChatRequest => ({ messages: [{ role: "user", content: text }], config: { model }, ...extra });
const recorder = () => join(mkdtempSync(join(tmpdir(), "crucible-fake-")), "calls.jsonl");
const calls = (f: string) => readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv: string[]; stdin: string; cwd: string; hasAnthropicKey: boolean; hasOpenAIKey: boolean });

async function collect(p: { stream: (r: ChatRequest) => AsyncIterable<{ type: string; text?: string }> }, req: ChatRequest) {
  let text = ""; const types: string[] = [];
  for await (const e of p.stream(req)) { types.push(e.type); if (e.type === "text_delta") text += e.text; }
  return { text, types };
}

describe("ClaudeCodeProvider (recorded real stream)", () => {
  it("streams text, reports usage, isolates the CLI and strips API keys so the subscription is used", async () => {
    const rec = recorder();
    process.env.ANTHROPIC_API_KEY = "sk-should-be-removed";
    const p = new ClaudeCodeProvider({ bin: FAKE, env: { FAKE_FIXTURE: fx("claude-success.jsonl"), FAKE_RECORD: rec } });
    const { text, types } = await collect(p, ask("haiku"));
    delete process.env.ANTHROPIC_API_KEY;
    expect(text).toBe("one two three");
    expect(types[0]).toBe("start");
    expect(types.at(-1)).toBe("end");
    const c = calls(rec)[0]!;
    expect(c.hasAnthropicKey).toBe(false);
    expect(c.stdin).toBe("Reply with exactly: one two three");
    for (const flag of ["-p", "--no-session-persistence", "--strict-mcp-config"]) expect(c.argv).toContain(flag);
    expect(c.argv[c.argv.indexOf("--tools") + 1]).toBe("");
    expect(c.argv[c.argv.indexOf("--model") + 1]).toBe("haiku");
    expect(c.cwd).toMatch(/crucible-claude-code-/);
    const res = await new ClaudeCodeProvider({ bin: FAKE, env: { FAKE_FIXTURE: fx("claude-success.jsonl") } }).chat(ask("haiku"));
    expect(res.message.content).toBe("one two three");
    expect(res.usage.outputTokens).toBeGreaterThan(0);
    expect(res.model).toBe("claude-haiku-5-5");
  });

  it("keeps the API key only when explicitly allowed", async () => {
    const rec = recorder();
    process.env.ANTHROPIC_API_KEY = "sk-keep";
    await new ClaudeCodeProvider({ bin: FAKE, allowApiKey: true, env: { FAKE_FIXTURE: fx("claude-success.jsonl"), FAKE_RECORD: rec } }).chat(ask("haiku"));
    delete process.env.ANTHROPIC_API_KEY;
    expect(calls(rec)[0]!.hasAnthropicKey).toBe(true);
  });

  it("rejects tool calling and images with a non-retryable 400", async () => {
    const p = new ClaudeCodeProvider({ bin: FAKE });
    await expect(p.chat(ask("haiku", "x", { config: { model: "haiku", tools: [{ name: "t", inputSchema: {} }] } }))).rejects.toMatchObject({ status: 400, retryable: false });
    await expect(p.chat({ messages: [{ role: "user", content: [{ type: "image", mediaType: "image/png", data: "AA" }] }], config: { model: "haiku" } })).rejects.toMatchObject({ status: 400 });
  });
});

describe("CodexProvider", () => {
  it("parses agent messages and usage, ignores warning items, strips OPENAI_API_KEY, and reads the prompt from stdin (recorded real stream)", async () => {
    const rec = recorder();
    process.env.OPENAI_API_KEY = "sk-should-be-removed";
    const res = await new CodexProvider({ bin: FAKE, env: { FAKE_FIXTURE: fx("codex-success.jsonl"), FAKE_RECORD: rec } }).chat({ messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "ping" }], config: { model: "gpt-5.5" } });
    delete process.env.OPENAI_API_KEY;
    expect(res.message.content).toBe("(demo model) You said: Reply with exactly the word pong.\n");
    expect(res.usage).toMatchObject({ inputTokens: 5073, outputTokens: 15, cacheReadTokens: 0 });
    const c = calls(rec)[0]!;
    expect(c.hasOpenAIKey).toBe(false);
    expect(c.argv.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(c.argv).toContain("read-only");
    expect(c.argv.at(-1)).toBe("-");
    expect(c.argv[c.argv.indexOf("-m") + 1]).toBe("gpt-5.5");
    expect(c.stdin).toBe("Instructions: Be brief.\n\nping");
  });

  it("omits -m for the default model and surfaces turn failures as rate limits", async () => {
    const rec = recorder();
    const err = await new CodexProvider({ bin: FAKE, env: { FAKE_FIXTURE: fx("codex-failed.synthetic.jsonl"), FAKE_RECORD: rec, FAKE_EXIT: "1" } }).chat(ask("default")).catch((e) => e);
    expect(err.message).toContain("usage limit");
    expect(err.status).toBe(429);
    expect(calls(rec)[0]!.argv).not.toContain("-m");
  });
});

describe("OpenCodeProvider (recorded real stream)", () => {
  it("streams text parts and sums step usage", async () => {
    const rec = recorder();
    const res = await new OpenCodeProvider({ bin: FAKE, env: { FAKE_FIXTURE: fx("opencode-success.jsonl"), FAKE_RECORD: rec } }).chat(ask("opencode/glm-5.3-flash-free"));
    expect(res.message.content).toContain("demo model");
    expect(res.usage).toMatchObject({ inputTokens: 6312, outputTokens: 15 });
    const c = calls(rec)[0]!;
    expect(c.argv.slice(0, 3)).toEqual(["run", "--format", "json"]);
    expect(c.argv[c.argv.indexOf("-m") + 1]).toBe("opencode/glm-5.3-flash-free");
    expect(c.argv.at(-1)).toBe("Reply with exactly: one two three");
  });

  it("fails fast with 429 when the free tier is rate limited, instead of hanging on OpenCode's silent retries", async () => {
    const t0 = Date.now();
    const err = await new OpenCodeProvider({ bin: FAKE, idleTimeoutMs: 30_000, env: { FAKE_STDERR: fx("opencode-ratelimit.stderr"), FAKE_HANG: "1" } }).chat(ask("opencode/glm-5.3-flash-free")).catch((e) => e);
    expect(err.status).toBe(429);
    expect(err.message).toMatch(/free usage limit/);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it("maps JSON error events", async () => {
    const err = await new OpenCodeProvider({ bin: FAKE, env: { FAKE_FIXTURE: fx("opencode-error.jsonl") } }).chat(ask("opencode/x")).catch((e) => e);
    expect(err.message).toContain("Proxy refused");
  });
});

describe("ClineProvider (recorded real stream)", () => {
  it("streams text, splits provider/model, passes the OpenRouter key, and guards one-word prompts", async () => {
    const rec = recorder();
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const res = await new ClineProvider({ bin: FAKE, env: { FAKE_FIXTURE: fx("cline-success.jsonl"), FAKE_RECORD: rec } }).chat(ask("openrouter/google/gemma-4-31b-it:free", "hi"));
    delete process.env.OPENROUTER_API_KEY;
    expect(res.message.content).toBe("(demo model) You said: Reply with exactly the word pong.");
    expect(res.usage).toMatchObject({ inputTokens: 1115, outputTokens: 14 });
    const c = calls(rec)[0]!;
    expect(c.argv[c.argv.indexOf("-P") + 1]).toBe("openrouter");
    expect(c.argv[c.argv.indexOf("-m") + 1]).toBe("google/gemma-4-31b-it:free");
    expect(c.argv[c.argv.indexOf("-k") + 1]).toBe("sk-or-test");
    expect(c.argv.at(-1)).toBe("User: hi");
  });

  it("maps auth failures to 401", async () => {
    const err = await new ClineProvider({ bin: FAKE, env: { FAKE_FIXTURE: fx("cline-auth-error.jsonl"), FAKE_EXIT: "1" } }).chat(ask("openrouter/x:free")).catch((e) => e);
    expect(err.status).toBe(401);
    expect(err.message).toContain("Missing Authentication header");
  });
});

describe("process control", () => {
  it("kills a CLI that goes silent (idle timeout) and one that is aborted", async () => {
    const t0 = Date.now();
    const idle = await new ClaudeCodeProvider({ bin: FAKE, idleTimeoutMs: 400, env: { FAKE_HANG: "1" } }).chat(ask("haiku")).catch((e) => e);
    expect(idle.status).toBe(504);
    expect(idle.message).toMatch(/no output/);
    expect(Date.now() - t0).toBeLessThan(4_000);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const aborted = await new ClaudeCodeProvider({ bin: FAKE, env: { FAKE_HANG: "1" } }).chat(ask("haiku"), ac.signal).catch((e) => e);
    expect(aborted.message).toMatch(/aborted/);
  });

  it("reports a missing binary as a non-retryable 503", async () => {
    await expect(new ClaudeCodeProvider({ bin: "/nonexistent/claude" }).chat(ask("haiku"))).rejects.toMatchObject({ status: 503, retryable: false });
  });
});

describe("routing", () => {
  it("never claims bare model ids, works when pinned, and falls back from a rate-limited free model", async () => {
    const limited = new OpenCodeProvider({ bin: FAKE, env: { FAKE_STDERR: fx("opencode-ratelimit.stderr"), FAKE_HANG: "1" } });
    const cline = new ClineProvider({ bin: FAKE, env: { FAKE_FIXTURE: fx("cline-success.jsonl") } });
    const router = new Router([limited, cline, new MockProvider()], { routes: [{ name: "free", strategy: "fallback", targets: [{ provider: "opencode", model: "opencode/glm-5.3-flash-free" }, { provider: "cline", model: "openrouter/google/gemma-4-31b-it:free" }] }] });
    // A bare model id is never picked up by a CLI provider, so a subscription is only used when asked for.
    expect(() => router.resolve("sonnet")).toThrow(/no provider serves model "sonnet"/);
    const gw = new Gateway({ providers: [limited, cline], router });
    const res = await gw.chat(ask("free"), { projectId: "p" });
    expect(res.provider).toBe("cline");
    expect(router.resolve("cline/openrouter/google/gemma-4-31b-it:free").attempts[0]?.model).toBe("openrouter/google/gemma-4-31b-it:free");
  });

  it("builds the free route from discovered catalogues", () => {
    const cat = { opencodeZen: ["opencode/a-free", "opencode/b-free"], openrouter: ["x/y:free", "z/w:free"], discoveredAt: 0, errors: [] };
    expect(buildFreeRoute(cat, { opencode: true, cline: true, openrouterKey: false })!.targets.map((t) => `${t.provider}/${t.model}`)).toEqual(["opencode/opencode/a-free", "opencode/opencode/b-free"]);
    const withKey = buildFreeRoute(cat, { opencode: true, cline: true, openrouterKey: true })!.targets.map((t) => `${t.provider}/${t.model}`);
    expect(withKey).toContain("cline/openrouter/x/y:free");
    expect(withKey).toContain("opencode/openrouter/x/y:free");
    expect(buildFreeRoute(cat, { opencode: false, cline: false, openrouterKey: false })).toBeNull();
  });
});

describe("renderTranscript", () => {
  it("passes a single turn through and renders conversations as a transcript", () => {
    expect(renderTranscript([{ role: "system", content: "S" }, { role: "user", content: "hi" }])).toEqual({ system: "S", prompt: "hi" });
    const t = renderTranscript([{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }]);
    expect(t.prompt).toContain("User: a\n\nAssistant: b\n\nUser: c");
  });
});
