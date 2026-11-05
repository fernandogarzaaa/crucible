import { describe, expect, it } from "vitest";
import { Store } from "./store.js";

// Runs only when a real Postgres is reachable: CRUCIBLE_TEST_PG_URL=postgres://user@host:port/db
const url = process.env.CRUCIBLE_TEST_PG_URL;
describe.skipIf(!url)("Store on real Postgres (node-postgres)", () => {
  it("runs the full repository surface against a live server", () => {
    const s = new Store({ url: url! });
    expect(s.dialect).toBe("postgres");
    const p = s.workbench.getProject("pgtest") ?? s.workbench.createProject("pgtest");
    const prompt = s.workbench.getPrompt(p.id, "greeter") ?? s.workbench.createPrompt(p.id, "greeter");
    const v = s.workbench.createVersion(prompt.id, { template: [{ role: "user", content: "Hi {{name}}" }], config: { model: "mock-fast" }, labels: ["production"] });
    expect(typeof v.version).toBe("number");
    expect(s.workbench.resolveVersion(p.id, "greeter@production")?.id).toBe(v.id);
    const t = s.tracing.startTrace({ projectId: p.id, name: "chat" });
    const sp = s.tracing.startSpan({ traceId: t.id, name: "llm", kind: "llm", model: "claude-haiku-5-5" });
    s.tracing.endSpan(sp.id, { usage: { inputTokens: 1000, outputTokens: 10 }, output: "hi" });
    s.tracing.endTrace(t.id, { output: "hi" });
    const got = s.tracing.getTrace(t.id)!;
    expect(got.spanCount).toBe(1);
    expect(got.totalTokens).toBe(1010);
    expect(got.costUsd).toBeGreaterThan(0);
    const stats = s.tracing.stats(p.id, 60_000);
    expect(stats.traces).toBeGreaterThanOrEqual(1);
    expect(typeof stats.p95Ms).toBe("number");
    const run = s.agents.createRun({ projectId: p.id, agentName: "pg-bot" });
    s.agents.appendEvent(run.id, "run_started", {});
    s.agents.appendEvent(run.id, "tool_result", { content: "x" });
    const fork = s.agents.fork(run.id, 1, { replaceEvent: { seq: 1, payload: { content: "patched" } } });
    expect(s.agents.events(fork.id)[1]?.payload).toEqual({ content: "patched" });
    expect(s.agents.fleet(p.id, 60_000)[0]?.agentName).toBe("pg-bot");
    const kb = s.rag.getKb(p.id, "docs") ?? s.rag.createKb({ projectId: p.id, name: "docs" });
    s.rag.upsertDocument({ knowledgeBaseId: kb.id, source: `doc-${Date.now()}.md`, title: "A", content: `c${Date.now()}`, chunks: [{ text: "Hard-stop budgets return HTTP 402 when exceeded", embedding: [1, 0, 0] }, { text: "Fork a run at any step", embedding: [0, 1, 0] }] });
    expect(s.rag.keywordSearch(kb.id, "budgets exceeded", 5).length).toBeGreaterThan(0);
    expect(s.rag.vectorSearch(kb.id, [0.9, 0.1, 0], 1)[0]).toBeDefined();
    s.gateway.setBudget({ projectId: p.id, scope: "project", limitUsd: 5, period: "monthly" });
    expect(s.gateway.listBudgets(p.id)[0]?.limitUsd).toBe(5);
    const { secret, key } = s.gateway.createKey(p.id, "ci");
    expect(s.gateway.verifyKey(secret)?.id).toBe(key.id);
    const a = s.ops.requestApproval({ projectId: p.id, runId: run.id, eventSeq: 1, title: "ok?" });
    expect(s.ops.resolveApproval(a.id, "approved", "test")?.status).toBe("approved");
    // nested transaction rollback leaves outer intact
    s.db.transaction(() => {
      s.workbench.createDataset(p.id, `outer-${Date.now()}`);
      try { s.db.transaction(() => { s.workbench.createDataset(p.id, `inner-${Date.now()}`); throw new Error("boom"); }); } catch { /* expected */ }
    });
    expect(s.workbench.listDatasets(p.id).some((d) => d.name.startsWith("outer-"))).toBe(true);
    expect(s.workbench.listDatasets(p.id).some((d) => d.name.startsWith("inner-"))).toBe(false);
    s.workbench.deleteProject(p.id);
    s.close();
  });
});
