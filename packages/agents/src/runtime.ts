import { createHash } from "node:crypto";
import type { AgentEvent, AgentEventType, ContentPart, Json, Message, Store } from "@crucible/core";
import type { Gateway } from "@crucible/gateway";
import type { AgentDefinition, AgentState, RunOptions, RunResult, Tool } from "./types.js";

export class RunKilled extends Error { constructor(msg = "run killed") { super(msg); this.name = "RunKilled"; } }

/** Stable hash of an LLM request: messages + tool names. Model and sampling params are excluded so a model override still matches. */
export const requestHash = (messages: Message[], toolNames: string[]): string =>
  createHash("sha256").update(JSON.stringify({ messages, tools: [...toolNames].sort() })).digest("hex").slice(0, 24);
export const toolCallHash = (name: string, input: unknown): string =>
  createHash("sha256").update(JSON.stringify({ name, input })).digest("hex").slice(0, 24);

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
    const matchMode = opts.replayMatch ?? "input";
    const boundaries = new Set(opts.replayBoundaries ?? ["llm", "tool"]);
    let cursor = 0;
    let cassetteLive = cassette.length > 0; // becomes false once we diverge (input mode) or run out
    let divergedAtSeq: number | null = null;
    const usedSeq = new Set<number>();
    const patched = (ev: AgentEvent): Json => (opts.replaceEvent && opts.replaceEvent.seq === ev.seq ? opts.replaceEvent.payload : ev.payload);

    const trace = this.store.tracing.startTrace({ projectId: opts.projectId, name: `agent:${def.name}`, metadata: { mode, ...(opts.metadata ?? {}) }, tags: ["agent", def.name] });
    const run = this.store.agents.createRun({
      projectId: opts.projectId, agentName: def.name, traceId: trace.id,
      metadata: { mode, replayMatch: matchMode, ...(mode !== "live" ? { replayBoundaries: [...boundaries] } : {}), ...(opts.metadata ?? {}) },
      parentRunId: mode === "live" ? null : (opts.sourceRunId ?? null), forkedAtSeq: mode === "fork" ? (opts.forkAtSeq ?? null) : null,
    });
    const emit = (type: AgentEventType, payload: Json, spanId: string | null = null): AgentEvent => {
      const ev = this.store.agents.appendEvent(run.id, type, payload, spanId);
      opts.onEvent?.(ev);
      return ev;
    };
    const diverge = (atSeq: number, reason: string) => {
      if (!cassetteLive) return;
      cassetteLive = false;
      divergedAtSeq = atSeq;
      emit("checkpoint", { kind: "cassette_diverged", atSeq, reason });
      this.store.db.run("UPDATE agent_runs SET metadata = ? WHERE id = ?", JSON.stringify({ ...this.store.agents.getRun(run.id)!.metadata, divergedAtSeq: atSeq, divergenceReason: reason }), run.id);
    };
    /**
     * Take a recorded response of `type` if we are still replaying. In "order" mode the next recorded event
     * of that type is used. In "input" mode the recorded request preceding the response must hash-match.
     */
    const recorded = (type: "llm_response" | "tool_result", hash: string): AgentEvent | undefined => {
      if (!cassetteLive) return undefined;
      if (!boundaries.has(type === "llm_response" ? "llm" : "tool")) {
        // This boundary runs live. Mark the matching recorded pair as consumed so later lookups stay aligned.
        const reqType = type === "llm_response" ? "llm_request" : "tool_call";
        if (matchMode === "order") {
          while (cursor < cassette.length && cassette[cursor]!.seq <= cutoff) { if (cassette[cursor++]!.type === type) break; }
        } else {
          const i = cassette.findIndex((e) => e.type === reqType && !usedSeq.has(e.seq) && e.seq <= cutoff);
          if (i >= 0) { usedSeq.add(cassette[i]!.seq); const r = cassette.slice(i + 1).find((e) => e.type === type && !usedSeq.has(e.seq)); if (r) usedSeq.add(r.seq); }
        }
        return undefined;
      }
      const reqType = type === "llm_response" ? "llm_request" : "tool_call";
      if (matchMode === "order") {
        while (cursor < cassette.length && cassette[cursor]!.seq <= cutoff) {
          const ev = cassette[cursor++]!;
          if (ev.type === type) return { ...ev, payload: patched(ev) };
        }
        diverge(cassette[Math.min(cursor, cassette.length - 1)]?.seq ?? 0, "cassette exhausted");
        return undefined;
      }
      // input mode: find the first unused request event with a matching hash inside the window, return its response.
      for (let i = 0; i < cassette.length; i++) {
        const req = cassette[i]!;
        if (req.seq > cutoff) break;
        if (req.type !== reqType || usedSeq.has(req.seq)) continue;
        const h = (req.payload as { hash?: string } | null)?.hash;
        if (h !== undefined && h !== hash) continue; // recordings made before hashing existed match by order
        const resp = cassette.slice(i + 1).find((e) => e.type === type && e.seq <= cutoff && !usedSeq.has(e.seq));
        if (!resp) break;
        usedSeq.add(req.seq); usedSeq.add(resp.seq);
        return { ...resp, payload: patched(resp) };
      }
      const nextReq = cassette.find((e) => e.type === reqType && !usedSeq.has(e.seq) && e.seq <= cutoff);
      diverge(nextReq?.seq ?? (cassette[cassette.length - 1]?.seq ?? 0), nextReq ? `${reqType} input changed` : "cassette exhausted");
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
        const reqHash = requestHash(state.messages, toolDefs.map((t) => t.name));
        emit("llm_request", { step: state.step, messageCount: state.messages.length, model: def.model.model, hash: reqHash });
        const span = this.store.tracing.startSpan({ traceId: trace.id, name: `step ${state.step}: llm`, kind: "llm", model: def.model.model, input: state.messages.slice(-4) });
        let assistant: Message, usage, costUsd = 0, stopReason: string, servedModel = def.model.model, fromCassette = false;
        const rec = recorded("llm_response", reqHash);
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
          const callHash = toolCallHash(tu.name, input);
          emit("tool_call", { id: tu.id, name: tu.name, input, hash: callHash });
          const tspan = this.store.tracing.startSpan({ traceId: trace.id, name: `tool: ${tu.name}`, kind: "tool", input });
          let content: string, isError = false;
          const recResult = recorded("tool_result", callHash);
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
      emit("run_finished", { output, steps: state.step, costUsd: state.costUsd, divergedAtSeq });
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
