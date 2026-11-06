import type { Db, Row } from "../db.js";
import { j, num, numOrNull, str, strOrNull, strOrUndef } from "../db.js";
import { newId } from "../ids.js";
import { estimateCost } from "../pricing.js";
import type { Json, Span, SpanKind, Trace, Usage } from "../schema.js";

const rowTrace = (r: Row): Trace => ({
  id: str(r.id), projectId: str(r.project_id), name: str(r.name), status: str(r.status) as Trace["status"],
  startedAt: num(r.started_at), endedAt: numOrNull(r.ended_at), input: j.dec<Json | undefined>(r.input, undefined),
  output: j.dec<Json | undefined>(r.output, undefined), metadata: j.dec<Record<string, Json>>(r.metadata, {}),
  tags: j.dec<string[]>(r.tags, []), sessionId: strOrUndef(r.session_id), userId: strOrUndef(r.user_id),
  totalTokens: num(r.total_tokens), costUsd: num(r.cost_usd), spanCount: num(r.span_count),
});
const rowSpan = (r: Row): Span => ({
  id: str(r.id), traceId: str(r.trace_id), parentSpanId: strOrNull(r.parent_span_id), name: str(r.name),
  kind: str(r.kind) as SpanKind, status: str(r.status) as Span["status"], startedAt: num(r.started_at), endedAt: numOrNull(r.ended_at),
  input: j.dec<Json | undefined>(r.input, undefined), output: j.dec<Json | undefined>(r.output, undefined),
  attributes: j.dec<Record<string, Json>>(r.attributes, {}), model: strOrUndef(r.model), provider: strOrUndef(r.provider),
  usage: j.dec<Usage | undefined>(r.usage, undefined), costUsd: r.cost_usd == null ? undefined : num(r.cost_usd), error: strOrUndef(r.error),
});

export interface TraceFilter {
  projectId: string;
  status?: Trace["status"];
  sessionId?: string;
  userId?: string;
  tag?: string;
  search?: string;
  since?: number;
  until?: number;
  limit?: number;
  offset?: number;
}

export class TracingRepo {
  constructor(private db: Db) {}

  startTrace(input: Partial<Trace> & { projectId: string; name: string }): Trace {
    const t: Trace = {
      id: input.id ?? newId.trace(), projectId: input.projectId, name: input.name, status: "running", startedAt: input.startedAt ?? Date.now(),
      endedAt: null, input: input.input, output: undefined, metadata: input.metadata ?? {}, tags: input.tags ?? [],
      sessionId: input.sessionId, userId: input.userId, totalTokens: 0, costUsd: 0, spanCount: 0,
    };
    this.db.run(
      `INSERT INTO traces (id, project_id, name, status, started_at, input, metadata, tags, session_id, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      t.id, t.projectId, t.name, t.status, t.startedAt, j.enc(t.input), j.enc(t.metadata), j.enc(t.tags), t.sessionId ?? null, t.userId ?? null,
    );
    return t;
  }

  endTrace(id: string, patch: { status?: Trace["status"]; output?: Json; metadata?: Record<string, Json>; endedAt?: number }): void {
    const cur = this.getTrace(id);
    if (!cur) return;
    this.db.run(
      "UPDATE traces SET status = ?, ended_at = ?, output = COALESCE(?, output), metadata = ? WHERE id = ?",
      patch.status ?? "ok", patch.endedAt ?? Date.now(), j.enc(patch.output), j.enc({ ...cur.metadata, ...(patch.metadata ?? {}) }), id,
    );
  }

  getTrace(id: string): Trace | undefined {
    const r = this.db.get("SELECT * FROM traces WHERE id = ?", id);
    return r ? rowTrace(r) : undefined;
  }

  listTraces(f: TraceFilter): Trace[] {
    const where: string[] = ["project_id = ?"];
    const params: Array<string | number> = [f.projectId];
    if (f.status) { where.push("status = ?"); params.push(f.status); }
    if (f.sessionId) { where.push("session_id = ?"); params.push(f.sessionId); }
    if (f.userId) { where.push("user_id = ?"); params.push(f.userId); }
    if (f.tag) { where.push("tags LIKE ?"); params.push(`%"${f.tag}"%`); }
    if (f.search) { where.push("(name LIKE ? OR input LIKE ? OR output LIKE ?)"); params.push(`%${f.search}%`, `%${f.search}%`, `%${f.search}%`); }
    if (f.since) { where.push("started_at >= ?"); params.push(f.since); }
    if (f.until) { where.push("started_at <= ?"); params.push(f.until); }
    params.push(f.limit ?? 50, f.offset ?? 0);
    return this.db.all(`SELECT * FROM traces WHERE ${where.join(" AND ")} ORDER BY started_at DESC LIMIT ? OFFSET ?`, ...params).map(rowTrace);
  }

  startSpan(input: Partial<Span> & { traceId: string; name: string; kind: SpanKind }): Span {
    const s: Span = {
      id: input.id ?? newId.span(), traceId: input.traceId, parentSpanId: input.parentSpanId ?? null, name: input.name, kind: input.kind,
      status: "running", startedAt: input.startedAt ?? Date.now(), endedAt: null, input: input.input, output: undefined,
      attributes: input.attributes ?? {}, model: input.model, provider: input.provider, usage: undefined, costUsd: undefined, error: undefined,
    };
    this.db.run(
      `INSERT INTO spans (id, trace_id, parent_span_id, name, kind, status, started_at, input, attributes, model, provider)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      s.id, s.traceId, s.parentSpanId, s.name, s.kind, s.status, s.startedAt, j.enc(s.input), j.enc(s.attributes), s.model ?? null, s.provider ?? null,
    );
    this.db.run("UPDATE traces SET span_count = span_count + 1 WHERE id = ?", s.traceId);
    return s;
  }

  endSpan(
    id: string,
    patch: { status?: Span["status"]; output?: Json; usage?: Usage; costUsd?: number; error?: string; attributes?: Record<string, Json>; model?: string; endedAt?: number },
  ): void {
    const cur = this.getSpan(id);
    if (!cur) return;
    const model = patch.model ?? cur.model;
    const cost = patch.costUsd ?? (patch.usage && model ? estimateCost(model, patch.usage) : undefined);
    this.db.transaction(() => {
      this.db.run(
        `UPDATE spans SET status = ?, ended_at = ?, output = COALESCE(?, output), usage = ?, cost_usd = ?, error = ?, attributes = ?, model = ? WHERE id = ?`,
        patch.status ?? (patch.error ? "error" : "ok"), patch.endedAt ?? Date.now(), j.enc(patch.output), j.enc(patch.usage), cost ?? null,
        patch.error ?? null, j.enc({ ...cur.attributes, ...(patch.attributes ?? {}) }), model ?? null, id,
      );
      if (patch.usage || cost) {
        const tokens = (patch.usage?.inputTokens ?? 0) + (patch.usage?.outputTokens ?? 0);
        this.db.run("UPDATE traces SET total_tokens = total_tokens + ?, cost_usd = cost_usd + ? WHERE id = ?", tokens, cost ?? 0, cur.traceId);
      }
      if (patch.error) this.db.run("UPDATE traces SET status = 'error' WHERE id = ?", cur.traceId);
    });
  }

  /** Insert a complete span in one call (used by batch ingestion / SDK flush). */
  recordSpan(span: Span): void {
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO spans (id, trace_id, parent_span_id, name, kind, status, started_at, ended_at, input, output, attributes, model, provider, usage, cost_usd, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET trace_id = excluded.trace_id, parent_span_id = excluded.parent_span_id, name = excluded.name, kind = excluded.kind, status = excluded.status,
           started_at = excluded.started_at, ended_at = excluded.ended_at, input = excluded.input, output = excluded.output, attributes = excluded.attributes, model = excluded.model,
           provider = excluded.provider, usage = excluded.usage, cost_usd = excluded.cost_usd, error = excluded.error`,
        span.id, span.traceId, span.parentSpanId, span.name, span.kind, span.status, span.startedAt, span.endedAt, j.enc(span.input), j.enc(span.output),
        j.enc(span.attributes), span.model ?? null, span.provider ?? null, j.enc(span.usage), span.costUsd ?? null, span.error ?? null,
      );
      const tokens = (span.usage?.inputTokens ?? 0) + (span.usage?.outputTokens ?? 0);
      this.db.run(
        "UPDATE traces SET span_count = (SELECT COUNT(*) FROM spans WHERE trace_id = ?), total_tokens = total_tokens + ?, cost_usd = cost_usd + ? WHERE id = ?",
        span.traceId, tokens, span.costUsd ?? 0, span.traceId,
      );
    });
  }

  getSpan(id: string): Span | undefined {
    const r = this.db.get("SELECT * FROM spans WHERE id = ?", id);
    return r ? rowSpan(r) : undefined;
  }

  listSpans(traceId: string): Span[] {
    return this.db.all("SELECT * FROM spans WHERE trace_id = ? ORDER BY started_at, id", traceId).map(rowSpan);
  }

  deleteTrace(id: string): void {
    this.db.run("DELETE FROM traces WHERE id = ?", id);
  }

  stats(projectId: string, sinceMs: number): { traces: number; errors: number; costUsd: number; tokens: number; p50Ms: number; p95Ms: number } {
    const rows = this.db.all<{ status: string; cost_usd: number; total_tokens: number; dur: number | null }>(
      "SELECT status, cost_usd, total_tokens, (ended_at - started_at) AS dur FROM traces WHERE project_id = ? AND started_at >= ?",
      projectId, Date.now() - sinceMs,
    );
    const durs = rows.map((r) => (r.dur == null ? null : Number(r.dur))).filter((d): d is number => d != null).sort((a, b) => a - b);
    const pct = (p: number) => (durs.length ? durs[Math.min(durs.length - 1, Math.floor(p * durs.length))]! : 0);
    return {
      traces: rows.length, errors: rows.filter((r) => r.status === "error").length,
      costUsd: rows.reduce((a, r) => a + Number(r.cost_usd), 0), tokens: rows.reduce((a, r) => a + Number(r.total_tokens), 0),
      p50Ms: pct(0.5), p95Ms: pct(0.95),
    };
  }
}
