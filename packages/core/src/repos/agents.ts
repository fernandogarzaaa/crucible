import type { Db, Row } from "../db.js";
import { j, num, numOrNull, str, strOrNull } from "../db.js";
import { newId } from "../ids.js";
import type { AgentEvent, AgentEventType, AgentRun, AgentRunStatus, Json } from "../schema.js";

const rowRun = (r: Row): AgentRun => ({
  id: str(r.id), projectId: str(r.project_id), agentName: str(r.agent_name), status: str(r.status) as AgentRunStatus,
  startedAt: num(r.started_at), endedAt: numOrNull(r.ended_at), parentRunId: strOrNull(r.parent_run_id), forkedAtSeq: numOrNull(r.forked_at_seq),
  traceId: strOrNull(r.trace_id), metadata: j.dec<Record<string, Json>>(r.metadata, {}), costUsd: num(r.cost_usd), eventCount: num(r.event_count),
});
const rowEvent = (r: Row): AgentEvent => ({
  id: str(r.id), runId: str(r.run_id), seq: num(r.seq), type: str(r.type) as AgentEventType, payload: j.dec<Json>(r.payload, null),
  spanId: strOrNull(r.span_id), ts: num(r.ts),
});

export class AgentsRepo {
  constructor(private db: Db) {}

  createRun(input: { projectId: string; agentName: string; traceId?: string | null; metadata?: Record<string, Json>; parentRunId?: string | null; forkedAtSeq?: number | null; id?: string }): AgentRun {
    const run: AgentRun = {
      id: input.id ?? newId.agentRun(), projectId: input.projectId, agentName: input.agentName, status: "running", startedAt: Date.now(), endedAt: null,
      parentRunId: input.parentRunId ?? null, forkedAtSeq: input.forkedAtSeq ?? null, traceId: input.traceId ?? null, metadata: input.metadata ?? {},
      costUsd: 0, eventCount: 0,
    };
    this.db.run(
      `INSERT INTO agent_runs (id, project_id, agent_name, status, started_at, parent_run_id, forked_at_seq, trace_id, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      run.id, run.projectId, run.agentName, run.status, run.startedAt, run.parentRunId, run.forkedAtSeq, run.traceId, j.enc(run.metadata),
    );
    return run;
  }
  getRun(id: string): AgentRun | undefined {
    const r = this.db.get("SELECT * FROM agent_runs WHERE id = ?", id);
    return r ? rowRun(r) : undefined;
  }
  listRuns(projectId: string, opts: { status?: AgentRunStatus; agentName?: string; limit?: number } = {}): AgentRun[] {
    const where = ["project_id = ?"];
    const params: Array<string | number> = [projectId];
    if (opts.status) { where.push("status = ?"); params.push(opts.status); }
    if (opts.agentName) { where.push("agent_name = ?"); params.push(opts.agentName); }
    params.push(opts.limit ?? 100);
    return this.db.all(`SELECT * FROM agent_runs WHERE ${where.join(" AND ")} ORDER BY started_at DESC LIMIT ?`, ...params).map(rowRun);
  }
  setStatus(id: string, status: AgentRunStatus, endedAt?: number): void {
    const terminal = status === "completed" || status === "failed" || status === "killed";
    this.db.run("UPDATE agent_runs SET status = ?, ended_at = COALESCE(?, ended_at) WHERE id = ?", status, terminal ? (endedAt ?? Date.now()) : null, id);
  }
  addCost(id: string, usd: number): void {
    this.db.run("UPDATE agent_runs SET cost_usd = cost_usd + ? WHERE id = ?", usd, id);
  }
  /** Append an event; `seq` is assigned atomically. */
  appendEvent(runId: string, type: AgentEventType, payload: Json, spanId: string | null = null): AgentEvent {
    return this.db.transaction(() => {
      const last = this.db.get<{ s: number | null }>("SELECT MAX(seq) AS s FROM agent_events WHERE run_id = ?", runId);
      const ev: AgentEvent = { id: newId.agentEvent(), runId, seq: Number(last?.s ?? -1) + 1, type, payload, spanId, ts: Date.now() };
      this.db.run("INSERT INTO agent_events (id, run_id, seq, type, payload, span_id, ts) VALUES (?, ?, ?, ?, ?, ?, ?)", ev.id, runId, ev.seq, type, j.enc(payload), spanId, ev.ts);
      this.db.run("UPDATE agent_runs SET event_count = event_count + 1 WHERE id = ?", runId);
      return ev;
    });
  }
  events(runId: string, opts: { fromSeq?: number; toSeq?: number } = {}): AgentEvent[] {
    return this.db
      .all("SELECT * FROM agent_events WHERE run_id = ? AND seq >= ? AND seq <= ? ORDER BY seq", runId, opts.fromSeq ?? 0, opts.toSeq ?? Number.MAX_SAFE_INTEGER)
      .map(rowEvent);
  }
  /**
   * Fork a run: copies events [0, atSeq] into a new run so the agent can be resumed from that point
   * with a different prompt, tool result, or model. The copied prefix keeps original timestamps.
   */
  fork(runId: string, atSeq: number, overrides: { metadata?: Record<string, Json>; replaceEvent?: { seq: number; payload: Json } } = {}): AgentRun {
    const src = this.getRun(runId);
    if (!src) throw new Error(`run not found: ${runId}`);
    return this.db.transaction(() => {
      const fork = this.createRun({
        projectId: src.projectId, agentName: src.agentName, parentRunId: runId, forkedAtSeq: atSeq,
        metadata: { ...src.metadata, ...(overrides.metadata ?? {}), forkedFrom: runId, forkedAtSeq: atSeq },
      });
      for (const ev of this.events(runId, { toSeq: atSeq })) {
        const payload = overrides.replaceEvent && overrides.replaceEvent.seq === ev.seq ? overrides.replaceEvent.payload : ev.payload;
        this.db.run("INSERT INTO agent_events (id, run_id, seq, type, payload, span_id, ts) VALUES (?, ?, ?, ?, ?, ?, ?)", newId.agentEvent(), fork.id, ev.seq, ev.type, j.enc(payload), ev.spanId, ev.ts);
      }
      this.db.run("UPDATE agent_runs SET event_count = (SELECT COUNT(*) FROM agent_events WHERE run_id = ?) WHERE id = ?", fork.id, fork.id);
      return this.getRun(fork.id)!;
    });
  }
  children(runId: string): AgentRun[] {
    return this.db.all("SELECT * FROM agent_runs WHERE parent_run_id = ? ORDER BY started_at", runId).map(rowRun);
  }
  fleet(projectId: string, sinceMs: number): Array<{ agentName: string; runs: number; running: number; failed: number; awaitingApproval: number; costUsd: number; avgDurationMs: number }> {
    return this.db
      .all(
        `SELECT agent_name, COUNT(*) AS runs,
           SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed, SUM(CASE WHEN status = 'awaiting_approval' THEN 1 ELSE 0 END) AS awaiting,
           SUM(cost_usd) AS cost, AVG(COALESCE(ended_at, ?) - started_at) AS avg_dur
         FROM agent_runs WHERE project_id = ? AND started_at >= ? GROUP BY agent_name ORDER BY runs DESC`,
        Date.now(), projectId, Date.now() - sinceMs,
      )
      .map((r) => ({
        agentName: str(r.agent_name), runs: num(r.runs), running: num(r.running), failed: num(r.failed), awaitingApproval: num(r.awaiting),
        costUsd: num(r.cost), avgDurationMs: num(r.avg_dur),
      }));
  }
  deleteRun(id: string): void {
    this.db.run("DELETE FROM agent_runs WHERE id = ?", id);
  }
}
