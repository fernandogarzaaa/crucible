import type { AgentEvent, AgentEventType, ContentPart, Json, Message, Store } from "@crucible/core";
import type { Gateway } from "@crucible/gateway";
import type { AgentDefinition, AgentState, RunOptions, RunResult, Tool } from "./types.js";

export class RunKilled extends Error { constructor(msg = "run killed") { super(msg); this.name = "RunKilled"; } }

const textOf = (m: Message): string => (typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? p.text : "")).join(""));

/**
 * The agent runtime executes a tool-using loop through the gateway and records every decision point
 * as an ordered event log. The same log drives deterministic replay and point-in-time forks:
 * in replay/fork mode, LLM responses and tool results are read from the recorded run instead of
 * being executed, until the cassette runs out (or the fork point is passed), then execution goes live.
 */
export class AgentRuntime {
  constructor(private readonly store: Store, private readonly gateway: Gateway) {}

  async run(def: AgentDefinition, opts: RunOptions): Promise<RunResult> {
    const mode = opts.mode ?? "live";
    const cassette = mode !== "live" && opts.sourceRunId ? this.store.agents.events(opts.sourceRunId) : [];
    const cutoff = mode === "fork" ? (opts.forkAtSeq ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
    let cursor = 0;

    const trace = this.store.tracing.startTrace({ projectId: opts.projectId, name: `agent:${def.name}`, metadata: { mode, ...(opts.metadata ?? {}) }, tags: ["agent", def.name] });
    const run = this.store.agents.createRun({
      projectId: opts.projectId, agentName: def.name, traceId: trace.id,
      metadata: { mode, ...(opts.metadata ?? {}) },
      parentRunId: mode === "live" ? null : (opts.sourceRunId ?? null), forkedAtSeq: mode === "fork" ? (opts.forkAtSeq ?? null) : null,
    });
    const emit = (type: AgentEventType, payload: Json, spanId: string | null = null): AgentEvent => {
      const ev = this.store.agents.appendEvent(run.id, type, payload, spanId);
      opts.onEvent?.(ev);
      return ev;
    };
    /** Take the next recorded event of a given type if we are still inside the cassette window. */
    const recorded = (type: AgentEventType): AgentEvent | undefined => {
      while (cursor < cassette.length && cassette[cursor]!.seq <= cutoff) {
        const ev = cassette[cursor++]!;
        if (ev.type === type) {
          const payload = opts.replaceEvent && opts.replaceEvent.seq === ev.seq ? opts.replaceEvent.payload : ev.payload;
          return { ...ev, payload };
        }
      }
      return undefined;
    };
    const checkKilled = () => {
      const cur = this.store.agents.getRun(run.id);
      if (cur?.status === "killed" || opts.signal?.aborted) throw new RunKilled();
    };

    const tools = new Map<string, Tool>((def.tools ?? []).map((t) => [t.name, t]));
    const toolDefs = (def.tools ?? []).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
    const state: AgentState = {
      messages: [...(def.system ? [{ role: "system" as const, content: def.system }] : []), ...(typeof opts.input === "string" ? [{ role: "user" as const, content: opts.input }] : opts.input)],
      step: 0, costUsd: 0, lastToolUses: [],
    };
    emit("run_started", { input: opts.input, model: def.model.model, tools: toolDefs.map((t) => t.name), mode, sourceRunId: opts.sourceRunId ?? null, forkAtSeq: opts.forkAtSeq ?? null });

    let output = "";
    try {
      for (state.step = 0; state.step < (def.maxSteps ?? 20); state.step++) {
        checkKilled();
        // ---- LLM turn
        const req = { messages: state.messages, config: { ...def.model, tools: toolDefs.length ? toolDefs : undefined } };
        emit("llm_request", { step: state.step, messageCount: state.messages.length, model: def.model.model });
        const span = this.store.tracing.startSpan({ traceId: trace.id, name: `step ${state.step}: llm`, kind: "llm", model: def.model.model, input: state.messages.slice(-4) });
        let assistant: Message, usage, costUsd = 0, stopReason: string, servedModel = def.model.model, fromCassette = false;
        const rec = recorded("llm_response");
        if (rec) {
          const p = rec.payload as { message: Message; usage: typeof usage; costUsd: number; stopReason: string; model: string };
          assistant = p.message; usage = p.usage; costUsd = 0; stopReason = p.stopReason; servedModel = p.model; fromCassette = true;
        } else {
          const res = await this.gateway.chat(req, { projectId: opts.projectId, traceId: trace.id, scopes: ["project", `agent:${def.name}`], signal: opts.signal });
          assistant = res.message; usage = res.usage; costUsd = res.costUsd; stopReason = res.stopReason; servedModel = res.model;
        }
        this.store.tracing.endSpan(span.id, { output: assistant.content as Json, usage, costUsd, model: servedModel, attributes: { replayed: fromCassette, stopReason } });
        state.costUsd += costUsd;
        if (costUsd) this.store.agents.addCost(run.id, costUsd);
        emit("llm_response", { message: assistant, usage, costUsd, stopReason, model: servedModel, replayed: fromCassette } as Json, span.id);
        state.messages.push(assistant);

        if (def.maxCostUsd !== undefined && state.costUsd > def.maxCostUsd) {
          emit("error", { reason: "max_cost_exceeded", costUsd: state.costUsd });
          this.store.agents.setStatus(run.id, "killed");
          throw new RunKilled(`max cost exceeded: $${state.costUsd.toFixed(4)}`);
        }

        // ---- Tool calls
        const toolUses = typeof assistant.content === "string" ? [] : assistant.content.filter((p): p is Extract<ContentPart, { type: "tool_use" }> => p.type === "tool_use");
        state.lastToolUses = toolUses;
        if (!toolUses.length || stopReason !== "tool_use") { output = textOf(assistant); break; }

        const results: ContentPart[] = [];
        for (const tu of toolUses) {
          checkKilled();
          const tool = tools.get(tu.name);
          const input = (tu.input ?? {}) as Record<string, Json>;
          emit("tool_call", { id: tu.id, name: tu.name, input });
          const tspan = this.store.tracing.startSpan({ traceId: trace.id, name: `tool: ${tu.name}`, kind: "tool", input });
          let content: string, isError = false;
          const recResult = recorded("tool_result");
          if (recResult) {
            const p = recResult.payload as { content: string; isError?: boolean };
            content = p.content; isError = !!p.isError;
            // Skip any recorded approval events belonging to this call.
          } else if (!tool) {
            content = `unknown tool: ${tu.name}`; isError = true;
          } else {
            const needs = typeof tool.requiresApproval === "function" ? tool.requiresApproval(input) : !!tool.requiresApproval;
            if (needs) {
              const ok = await this.awaitApproval(run.id, opts.projectId, tu, input, emit, opts.approvalTimeoutMs ?? 30 * 60_000, opts.signal);
              if (!ok) { content = `tool call "${tu.name}" was rejected by a human reviewer`; isError = true; }
              else { ({ content, isError } = await this.execTool(tool, input, { runId: run.id, projectId: opts.projectId, step: state.step, signal: opts.signal })); }
            } else {
              ({ content, isError } = await this.execTool(tool, input, { runId: run.id, projectId: opts.projectId, step: state.step, signal: opts.signal }));
            }
          }
          this.store.tracing.endSpan(tspan.id, { output: content, error: isError ? content : undefined, attributes: { replayed: !!recResult } });
          emit("tool_result", { id: tu.id, name: tu.name, content, isError, replayed: !!recResult }, tspan.id);
          results.push({ type: "tool_result", toolUseId: tu.id, content, isError });
        }
        state.messages.push({ role: "user", content: results });
        emit("state_snapshot", { step: state.step, messageCount: state.messages.length, costUsd: state.costUsd });
        if (def.shouldContinue && !def.shouldContinue(state)) { output = textOf(assistant); break; }
      }
      emit("run_finished", { output, steps: state.step, costUsd: state.costUsd });
      this.store.agents.setStatus(run.id, "completed");
      this.store.tracing.endTrace(trace.id, { output, metadata: { steps: state.step } });
    } catch (err) {
      const killed = err instanceof RunKilled;
      emit("error", { message: (err as Error).message, killed });
      this.store.agents.setStatus(run.id, killed ? "killed" : "failed");
      this.store.tracing.endTrace(trace.id, { status: "error", metadata: { error: (err as Error).message } });
      if (!killed) throw err;
    }
    return { run: this.store.agents.getRun(run.id)!, output, state };
  }

  /** Deterministically re-execute a recorded run (no model or tool calls are made while the cassette lasts). */
  replay(def: AgentDefinition, sourceRunId: string, extra: Partial<RunOptions> = {}): Promise<RunResult> {
    const src = this.store.agents.getRun(sourceRunId);
    if (!src) throw new Error(`run not found: ${sourceRunId}`);
    const started = this.store.agents.events(sourceRunId).find((e) => e.type === "run_started");
    const input = ((started?.payload as { input?: string | Message[] })?.input) ?? "";
    return this.run(def, { projectId: src.projectId, input, mode: "replay", sourceRunId, ...extra });
  }

  /** Resume from a point in a recorded run with optional modifications, then continue live. */
  fork(def: AgentDefinition, sourceRunId: string, atSeq: number, extra: Partial<RunOptions> = {}): Promise<RunResult> {
    const src = this.store.agents.getRun(sourceRunId);
    if (!src) throw new Error(`run not found: ${sourceRunId}`);
    const started = this.store.agents.events(sourceRunId).find((e) => e.type === "run_started");
    const input = ((started?.payload as { input?: string | Message[] })?.input) ?? "";
    return this.run(def, { projectId: src.projectId, input, mode: "fork", sourceRunId, forkAtSeq: atSeq, ...extra });
  }

  kill(runId: string, actor = "system", reason?: string): void {
    this.store.agents.setStatus(runId, "killed");
    this.store.ops.audit({ projectId: this.store.agents.getRun(runId)?.projectId, actor, action: "agent.kill", targetType: "agent_run", targetId: runId, details: { reason: reason ?? null } });
  }

  private async execTool(tool: Tool, input: Record<string, Json>, ctx: Parameters<Tool["handler"]>[1]): Promise<{ content: string; isError: boolean }> {
    try {
      const out = await tool.handler(input, ctx);
      return { content: typeof out === "string" ? out : JSON.stringify(out), isError: false };
    } catch (err) {
      return { content: `tool error: ${(err as Error).message}`, isError: true };
    }
  }

  private async awaitApproval(runId: string, projectId: string, tu: Extract<ContentPart, { type: "tool_use" }>, input: Record<string, Json>, emit: (t: AgentEventType, p: Json) => AgentEvent, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    const ev = emit("approval_requested", { toolUseId: tu.id, name: tu.name, input });
    const approval = this.store.ops.requestApproval({ projectId, runId, eventSeq: ev.seq, title: `Allow ${tu.name}?`, details: { input } });
    this.store.agents.setStatus(runId, "awaiting_approval");
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted || this.store.agents.getRun(runId)?.status === "killed") throw new RunKilled();
      const cur = this.store.ops.getApproval(approval.id);
      if (cur && cur.status !== "pending") {
        this.store.agents.setStatus(runId, "running");
        emit("approval_resolved", { approvalId: cur.id, status: cur.status, by: cur.resolvedBy, reason: cur.reason });
        return cur.status === "approved";
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    this.store.ops.resolveApproval(approval.id, "expired", "system", "timeout");
    this.store.agents.setStatus(runId, "running");
    emit("approval_resolved", { approvalId: approval.id, status: "expired" });
    return false;
  }
}
