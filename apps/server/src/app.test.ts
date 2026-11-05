import { describe, expect, it } from "vitest";
import { Store } from "@crucible/core";
import { MockProvider } from "@crucible/gateway";
import { createApp, createContext } from "./app.js";

function boot(open: () => Store = () => Store.memory()) {
  const provider = new MockProvider({ reply: (req) => {
    const text = JSON.stringify(req.messages);
    if (text.includes("strict evaluator")) return '{"score": 1, "reason": "ok"}';
    const last = req.messages[req.messages.length - 1]!;
    if (Array.isArray(last.content) && last.content.some((p) => p.type === "tool_result")) return "The knowledge base says budgets return 402.";
    if (text.includes("search_knowledge") && text.includes("budget")) return { toolUse: { name: "search_knowledge", input: { query: "budget exceeded status" } } };
    if (text.includes("deploy") && text.includes("production")) return { toolUse: { name: "deploy", input: { service: "api", environment: "production" } } };
    return "echo";
  } });
  const ctx = createContext({ store: open(), providers: [provider], registerDemoAgents: true, defaultModel: "mock-smart", loadUserAgents: false });
  const app = createApp(ctx, { quiet: true });
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return { ctx, app, api };
}

describe.each([["sqlite", () => Store.memory()], ["postgres (pglite)", () => Store.pglite()]] as const)("server on %s", (_name, open) => {
  it("serves the whole platform over HTTP", async () => {
    const { api } = boot(open);
    expect((await api("GET", "/api/health")).body.ok).toBe(true);

    // Prompts + datasets + evals
    const prompt = await api("POST", "/api/projects/default/prompts", { name: "qa", template: [{ role: "user", content: "{{q}}" }], config: { model: "fast" }, labels: ["production"] });
    expect(prompt.status).toBe(201);
    expect((await api("GET", "/api/projects/default/prompts/resolve?ref=qa@production")).body.version).toBe(1);
    const ds = await api("POST", "/api/projects/default/datasets", { name: "qa-set", items: [{ input: { q: "hi" }, expected: "echo" }, { input: { q: "yo" }, expected: "nope" }] });
    expect(ds.body.itemCount).toBe(2);
    const ev = await api("POST", "/api/projects/default/evals", { name: "qa-eval", datasetId: ds.body.id, promptVersionId: prompt.body.version.id, scorers: [{ type: "exact_match" }, { type: "llm_judge", model: "mock-fast", rubric: "correct?", scale: [0, 1] }], run: true });
    expect(ev.status).toBe(201);
    await new Promise((r) => setTimeout(r, 300));
    const detail = await api("GET", `/api/evals/${ev.body.id}`);
    expect(detail.body.status).toBe("completed");
    expect(detail.body.summary.scores.exact_match.passRate).toBe(0.5);
    expect(detail.body.results).toHaveLength(2);

    // Gateway: OpenAI- and Anthropic-compatible endpoints, requests log, budgets, keys
    const oa = await api("POST", "/v1/chat/completions", { model: "smart", messages: [{ role: "user", content: "hello" }] });
    expect(oa.body.choices[0].message.content).toBe("echo");
    const an = await api("POST", "/v1/messages", { model: "fast", max_tokens: 10, messages: [{ role: "user", content: "hello" }] });
    expect(an.body.content[0].text).toBe("echo");
    expect((await api("GET", "/api/projects/default/gateway/stats")).body.requests).toBeGreaterThan(2);
    const key = await api("POST", "/api/projects/default/keys", { name: "ci" });
    expect(key.body.secret.startsWith("cru_")).toBe(true);
    await api("POST", "/api/projects/default/budgets", { scope: "project", limitUsd: 0.0000001, period: "total" });
    const blocked = await api("POST", "/v1/chat/completions", { model: "smart", messages: [{ role: "user", content: "x" }] });
    expect(blocked.status).toBe(402);
    expect((await api("DELETE", `/api/budgets/${(await api("GET", "/api/projects/default/budgets")).body[0].id}`)).status).toBe(204);

    // RAG: ingest, query inspector, retrieval eval
    const kb = await api("POST", "/api/projects/default/kbs", { name: "docs" });
    await api("POST", `/api/kbs/${kb.body.id}/documents`, [{ source: "budgets.md", content: "When a hard-stop budget is exceeded the gateway returns HTTP 402 budget_exceeded." }, { source: "replay.md", content: "Fork a run from any step to test a different tool result." }]);
    const q = await api("POST", `/api/kbs/${kb.body.id}/query`, { query: "budget exceeded status", k: 1, trace: true });
    expect(q.body.hits[0].source).toBe("budgets.md");
    expect(q.body.traceId).toBeTruthy();
    expect((await api("POST", `/api/kbs/${kb.body.id}/evaluate`, { cases: [{ query: "fork a run", expectedSources: ["replay.md"] }], k: 1 })).body.hitRate).toBe(1);

    // Agents: run a registered agent that uses the KB, then fork with a patched tool result and diff
    const start = await api("POST", "/api/projects/default/agents/researcher/run", { input: "What happens when a budget is exceeded?" });
    expect(start.status).toBe(202);
    await new Promise((r) => setTimeout(r, 400));
    const run = await api("GET", `/api/runs/${start.body.runId}`);
    expect(run.body.status).toBe("completed");
    const toolResult = run.body.events.find((e: { type: string }) => e.type === "tool_result");
    const fork = await api("POST", `/api/runs/${start.body.runId}/fork`, { atSeq: toolResult.seq, replaceEvent: { seq: toolResult.seq, payload: { ...toolResult.payload, content: "patched" } } });
    await new Promise((r) => setTimeout(r, 400));
    const diff = await api("GET", `/api/runs/${start.body.runId}/diff/${fork.body.runId}`);
    expect(diff.body.divergedAtSeq).toBe(toolResult.seq);
    expect((await api("GET", "/api/projects/default/fleet")).body[0].agentName).toBe("researcher");

    // Human-in-the-loop approval flow
    const rel = await api("POST", "/api/projects/default/agents/release-manager/run", { input: "deploy api to production" });
    await new Promise((r) => setTimeout(r, 400));
    const pending = await api("GET", "/api/projects/default/approvals?status=pending");
    expect(pending.body).toHaveLength(1);
    const resolved = await api("POST", `/api/approvals/${pending.body[0].id}/resolve`, { status: "approved", reason: "ship it" });
    expect(resolved.body.status).toBe("approved");
    await new Promise((r) => setTimeout(r, 600));
    expect((await api("GET", `/api/runs/${rel.body.runId}`)).body.status).toBe("completed");

    // Traces, SDK ingest, overview, audit
    const traces = await api("GET", "/api/projects/default/traces?tag=agent");
    expect(traces.body.length).toBeGreaterThanOrEqual(3);
    const ingest = await api("POST", "/api/ingest", { traces: [{ id: "tr_ext1", name: "external", projectId: "default", startedAt: Date.now() - 10, endedAt: Date.now(), status: "ok" }], spans: [{ id: "sp_ext1", traceId: "tr_ext1", parentSpanId: null, name: "llm", kind: "llm", status: "ok", startedAt: Date.now() - 10, endedAt: Date.now(), attributes: {}, model: "claude-haiku-5-5", usage: { inputTokens: 100, outputTokens: 50 }, costUsd: 0.00035 }] });
    expect(ingest.body.spans).toBe(1);
    expect((await api("GET", "/api/traces/tr_ext1")).body.spans).toHaveLength(1);
    const overview = await api("GET", "/api/projects/default/overview");
    expect(overview.body.counts.prompts).toBe(1);
    expect(overview.body.fleet.length).toBe(2);
    expect((await api("GET", "/api/projects/default/audit")).body.some((a: { action: string }) => a.action === "approval.approved")).toBe(true);
  });

  it("enforces API keys and project scoping", async () => {
    const { api, app } = boot(open);
    const other = await api("POST", "/api/projects", { name: "team-b" });
    const key = await api("POST", `/api/projects/${other.body.id}/keys`, { name: "svc" });
    const ok = await app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key.body.secret}` }, body: JSON.stringify({ model: "mock-fast", messages: [{ role: "user", content: "hi" }] }) });
    expect(ok.status).toBe(200);
    const bad = await app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer cru_nope" }, body: "{}" });
    expect(bad.status).toBe(401);
    const cross = await app.request("/api/projects/default/traces", { headers: { authorization: `Bearer ${key.body.secret}` } });
    expect(cross.status).toBe(403);
    expect((await api("GET", `/api/projects/${other.body.id}/gateway/requests`)).body).toHaveLength(1);
  });
});
