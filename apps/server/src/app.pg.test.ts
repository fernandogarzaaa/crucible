import { describe, expect, it } from "vitest";
import { Store } from "@crucible/core";
import { MockProvider } from "@crucible/gateway";
import { createApp, createContext } from "./app.js";

const url = process.env.CRUCIBLE_TEST_PG_URL;
describe.skipIf(!url)("server on real Postgres", () => {
  it("runs prompts, evals, gateway, rag, agents and approvals end to end", async () => {
    const store = new Store({ url: url! });
    const provider = new MockProvider({ reply: (req) => {
      const text = JSON.stringify(req.messages);
      if (text.includes("strict evaluator")) return '{"score": 1}';
      const last = req.messages[req.messages.length - 1]!;
      if (Array.isArray(last.content) && last.content.some((p) => p.type === "tool_result")) return "answered from kb";
      if (text.includes("search_knowledge")) return { toolUse: { name: "search_knowledge", input: { query: "q" } } };
      return "echo";
    } });
    const ctx = createContext({ store, providers: [provider], registerDemoAgents: true, defaultModel: "mock-smart", loadUserAgents: false });
    const app = createApp(ctx, { quiet: true });
    const api = async (method: string, path: string, body?: unknown) => { const res = await app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); const t = await res.text(); return { status: res.status, body: t ? JSON.parse(t) : null }; };
    const proj = await api("POST", "/api/projects", { name: `pg-e2e-${Date.now()}` });
    const P = proj.body.slug;
    const prompt = await api("POST", `/api/projects/${P}/prompts`, { name: "qa", template: [{ role: "user", content: "{{q}}" }], config: { model: "mock-fast" } });
    const ds = await api("POST", `/api/projects/${P}/datasets`, { name: "qa-set", items: [{ input: { q: "hi" }, expected: "echo" }] });
    const ev = await api("POST", `/api/projects/${P}/evals`, { name: "qa-eval", datasetId: ds.body.id, promptVersionId: prompt.body.version.id, scorers: [{ type: "exact_match" }], run: true });
    await new Promise((r) => setTimeout(r, 800));
    expect((await api("GET", `/api/evals/${ev.body.id}`)).body.summary.scores.exact_match.passRate).toBe(1);
    const kb = await api("POST", `/api/projects/${P}/kbs`, { name: "docs" });
    await api("POST", `/api/kbs/${kb.body.id}/documents`, [{ source: "a.md", content: "Hard-stop budgets return HTTP 402." }]);
    expect((await api("POST", `/api/kbs/${kb.body.id}/query`, { query: "budget 402", k: 1 })).body.hits[0].source).toBe("a.md");
    const start = await api("POST", `/api/projects/${P}/agents/researcher/run`, { input: "budgets?" });
    await new Promise((r) => setTimeout(r, 1500));
    const run = await api("GET", `/api/runs/${start.body.runId}`);
    expect(run.body.status).toBe("completed");
    expect(run.body.events.some((e: { type: string }) => e.type === "tool_result")).toBe(true);
    const oa = await api("POST", "/v1/chat/completions", { model: "mock-fast", messages: [{ role: "user", content: "x" }] });
    expect(oa.body.choices[0].message.content).toBe("echo");
    expect((await api("GET", `/api/projects/${P}/overview`)).body.fleet[0].agentName).toBe("researcher");
    store.workbench.deleteProject(proj.body.id);
    store.close();
  });
});
