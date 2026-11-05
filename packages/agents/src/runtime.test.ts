import { describe, expect, it } from "vitest";
import { Store } from "@crucible/core";
import { Gateway, MockProvider } from "@crucible/gateway";
import { AgentRuntime } from "./runtime.js";
import { diffRuns } from "./diff.js";
import type { AgentDefinition } from "./types.js";

function setup() {
  const store = Store.memory();
  const project = store.workbench.ensureDefaultProject();
  let turn = 0;
  const provider = new MockProvider({ reply: (req) => {
    const last = req.messages[req.messages.length - 1]!;
    const hasToolResult = Array.isArray(last.content) && last.content.some((p) => p.type === "tool_result");
    if (!hasToolResult) { turn++; return { toolUse: { name: "lookup", input: { q: "weather" } } }; }
    const content = (last.content as Array<{ type: string; content?: string }>).find((p) => p.type === "tool_result")?.content ?? "";
    return `Result was: ${content}`;
  } });
  const gateway = new Gateway({ providers: [provider], store });
  const rt = new AgentRuntime(store, gateway);
  let lookups = 0;
  const def: AgentDefinition = {
    name: "weather-bot", model: { model: "mock-smart" }, maxSteps: 5,
    tools: [{ name: "lookup", description: "look things up", inputSchema: { type: "object" }, handler: () => { lookups++; return `sunny #${lookups}`; } }],
  };
  return { store, project, rt, def, counters: { get lookups() { return lookups; }, get turns() { return turn; } } };
}

describe("AgentRuntime", () => {
  it("records a live run with tool calls and traces", async () => {
    const { store, project, rt, def } = setup();
    const res = await rt.run(def, { projectId: project.id, input: "what's the weather?" });
    expect(res.output).toBe("Result was: sunny #1");
    expect(res.run.status).toBe("completed");
    const types = store.agents.events(res.run.id).map((e) => e.type);
    expect(types).toEqual(["run_started", "llm_request", "llm_response", "tool_call", "tool_result", "state_snapshot", "llm_request", "llm_response", "run_finished"]);
    expect(store.tracing.listSpans(res.run.traceId!).map((s) => s.kind)).toEqual(["llm", "tool", "llm"]);
  });

  it("replays deterministically without calling tools or the model", async () => {
    const { store, project, rt, def, counters } = setup();
    const live = await rt.run(def, { projectId: project.id, input: "weather?" });
    const before = { lookups: counters.lookups, turns: counters.turns };
    const replay = await rt.replay(def, live.run.id);
    expect(replay.output).toBe(live.output);
    expect(counters.lookups).toBe(before.lookups);
    expect(counters.turns).toBe(before.turns);
    expect(replay.run.parentRunId).toBe(live.run.id);
    expect(store.agents.events(replay.run.id).filter((e) => e.type === "llm_response").every((e) => (e.payload as { replayed: boolean }).replayed)).toBe(true);
  });

  it("forks at a tool result with a patched payload and continues live", async () => {
    const { store, project, rt, def } = setup();
    const live = await rt.run(def, { projectId: project.id, input: "weather?" });
    const toolResult = store.agents.events(live.run.id).find((e) => e.type === "tool_result")!;
    const fork = await rt.fork(def, live.run.id, toolResult.seq, { replaceEvent: { seq: toolResult.seq, payload: { ...(toolResult.payload as object), content: "stormy" } } });
    expect(fork.output).toBe("Result was: stormy");
    expect(fork.run.forkedAtSeq).toBe(toolResult.seq);
    const d = diffRuns(store, live.run.id, fork.run.id);
    expect(d.divergedAtSeq).toBe(toolResult.seq);
    expect(d.a.output).toBe("Result was: sunny #1");
    expect(d.b.output).toBe("Result was: stormy");
  });

  it("pauses for human approval and honours rejection", async () => {
    const { store, project, rt, def } = setup();
    def.tools![0]!.requiresApproval = true;
    const p = rt.run(def, { projectId: project.id, input: "weather?", approvalTimeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 300));
    const pending = store.ops.listApprovals(project.id, "pending");
    expect(pending).toHaveLength(1);
    expect(store.agents.listRuns(project.id, { status: "awaiting_approval" })).toHaveLength(1);
    store.ops.resolveApproval(pending[0]!.id, "rejected", "fernando", "not now");
    const res = await p;
    expect(res.output).toContain("rejected");
    expect(res.run.status).toBe("completed");
  });

  it("kill switch stops a run", async () => {
    const { store, project, rt, def } = setup();
    def.tools![0]!.handler = async () => { await new Promise((r) => setTimeout(r, 400)); return "late"; };
    const p = rt.run(def, { projectId: project.id, input: "weather?" });
    await new Promise((r) => setTimeout(r, 150));
    const running = store.agents.listRuns(project.id, { status: "running" })[0]!;
    rt.kill(running.id, "fernando", "runaway");
    const res = await p;
    expect(res.run.status).toBe("killed");
    expect(store.ops.auditLog(project.id)[0]?.action).toBe("agent.kill");
  });
});
