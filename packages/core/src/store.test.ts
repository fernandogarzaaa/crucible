import { describe, expect, it } from "vitest";
import { Store } from "./store.js";
import { renderTemplate } from "./repos/workbench.js";
import { estimateCost } from "./pricing.js";

describe.each([["sqlite", () => Store.memory()], ["postgres (pglite)", () => Store.pglite()]] as const)("Store on %s", (_name, open) => {
  it("manages prompts, versions and labels", () => {
    const s = open();
    const p = s.workbench.ensureDefaultProject();
    const prompt = s.workbench.createPrompt(p.id, "greeter");
    const v1 = s.workbench.createVersion(prompt.id, { template: [{ role: "user", content: "Hi {{name}}" }], config: { model: "claude-haiku-5-5" }, labels: ["production"] });
    const v2 = s.workbench.createVersion(prompt.id, { template: [{ role: "user", content: "Hello {{name}}, {{greeting.suffix}}" }], config: { model: "claude-haiku-5-5" } });
    expect(v1.variables).toEqual(["name"]);
    expect(v2.variables).toEqual(["name", "greeting.suffix"]);
    expect(s.workbench.resolveVersion(p.id, "greeter")?.version).toBe(2);
    expect(s.workbench.resolveVersion(p.id, "greeter@production")?.id).toBe(v1.id);
    s.workbench.setLabel(v2.id, "production");
    expect(s.workbench.resolveVersion(p.id, "greeter@production")?.id).toBe(v2.id);
    expect(s.workbench.getVersion(v1.id)?.labels).toEqual([]);
    expect(renderTemplate(v2.template, { name: "Ada", greeting: { suffix: "welcome" } })[0]?.content).toBe("Hello Ada, welcome");
    s.close();
  });

  it("records traces with spans and aggregates cost", () => {
    const s = open();
    const p = s.workbench.ensureDefaultProject();
    const t = s.tracing.startTrace({ projectId: p.id, name: "chat" });
    const sp = s.tracing.startSpan({ traceId: t.id, name: "llm", kind: "llm", model: "claude-sonnet-5-5" });
    s.tracing.endSpan(sp.id, { usage: { inputTokens: 1000, outputTokens: 500 }, output: "hi" });
    s.tracing.endTrace(t.id, { output: "hi" });
    const got = s.tracing.getTrace(t.id)!;
    expect(got.spanCount).toBe(1);
    expect(got.totalTokens).toBe(1500);
    expect(got.costUsd).toBeCloseTo(estimateCost("claude-sonnet-5-5", { inputTokens: 1000, outputTokens: 500 }), 8);
    expect(s.tracing.stats(p.id, 60_000).traces).toBe(1);
    s.close();
  });

  it("forks agent runs at a sequence number with an overridden event", () => {
    const s = open();
    const p = s.workbench.ensureDefaultProject();
    const run = s.agents.createRun({ projectId: p.id, agentName: "researcher" });
    s.agents.appendEvent(run.id, "run_started", {});
    s.agents.appendEvent(run.id, "tool_call", { name: "search", input: { q: "a" } });
    s.agents.appendEvent(run.id, "tool_result", { result: "original" });
    s.agents.appendEvent(run.id, "llm_response", { text: "done" });
    const fork = s.agents.fork(run.id, 2, { replaceEvent: { seq: 2, payload: { result: "patched" } } });
    const evs = s.agents.events(fork.id);
    expect(evs.map((e: { type: string }) => e.type)).toEqual(["run_started", "tool_call", "tool_result"]);
    expect(evs[2]?.payload).toEqual({ result: "patched" });
    expect(fork.parentRunId).toBe(run.id);
    expect(s.agents.children(run.id)).toHaveLength(1);
    s.close();
  });

  it("enforces budgets from gateway spend", () => {
    const s = open();
    const p = s.workbench.ensureDefaultProject();
    s.gateway.setBudget({ projectId: p.id, scope: "project", limitUsd: 1, period: "daily" });
    s.gateway.record({ projectId: p.id, apiKeyId: null, requestedModel: "m", servedModel: "m", provider: "x", route: "chat", status: 200, cached: false, fallbackDepth: 0, latencyMs: 10, usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0.6, traceId: null, error: null });
    expect(s.gateway.checkBudgets(p.id, ["project"])).toBeUndefined();
    s.gateway.record({ projectId: p.id, apiKeyId: null, requestedModel: "m", servedModel: "m", provider: "x", route: "chat", status: 200, cached: false, fallbackDepth: 0, latencyMs: 10, usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0.5, traceId: null, error: null });
    expect(s.gateway.checkBudgets(p.id, ["project"])?.spentUsd).toBeCloseTo(1.1);
    const { secret, key } = s.gateway.createKey(p.id, "ci");
    expect(s.gateway.verifyKey(secret)?.id).toBe(key.id);
    expect(s.gateway.verifyKey("nope")).toBeUndefined();
    s.close();
  });

  it("indexes chunks for keyword and vector search", () => {
    const s = open();
    const p = s.workbench.ensureDefaultProject();
    const kb = s.rag.createKb({ projectId: p.id, name: "docs" });
    s.rag.upsertDocument({ knowledgeBaseId: kb.id, source: "a.md", title: "A", content: "x", chunks: [
      { text: "Crucible stores traces in SQLite", embedding: [1, 0, 0] },
      { text: "Budgets stop runaway agent spend", embedding: [0, 1, 0] },
    ] });
    expect(s.rag.keywordSearch(kb.id, "sqlite traces", 5)[0]).toBeDefined();
    const top = s.rag.vectorSearch(kb.id, [0, 0.9, 0.1], 1)[0]!;
    expect(s.rag.getChunk(top.chunkId)?.text).toContain("Budgets");
    const again = s.rag.upsertDocument({ knowledgeBaseId: kb.id, source: "a.md", title: "A", content: "x", chunks: [] });
    expect(again.changed).toBe(false);
    s.close();
  });

  it("handles approvals and audit", () => {
    const s = open();
    const p = s.workbench.ensureDefaultProject();
    const run = s.agents.createRun({ projectId: p.id, agentName: "deployer" });
    const a = s.ops.requestApproval({ projectId: p.id, runId: run.id, eventSeq: 3, title: "Deploy to prod?" });
    expect(s.ops.listApprovals(p.id, "pending")).toHaveLength(1);
    s.ops.resolveApproval(a.id, "approved", "fernando");
    expect(s.ops.getApproval(a.id)?.status).toBe("approved");
    s.ops.audit({ projectId: p.id, actor: "fernando", action: "approval.approve", targetType: "approval", targetId: a.id });
    expect(s.ops.auditLog(p.id)).toHaveLength(1);
    s.close();
  });
});
