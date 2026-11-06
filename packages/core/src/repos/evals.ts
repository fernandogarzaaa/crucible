import type { Db, Row } from "../db.js";
import { j, num, numOrNull, str, strOrNull } from "../db.js";
import { newId } from "../ids.js";
import type { Eval, EvalResult, Json, Score, ScorerConfig } from "../schema.js";

const rowEval = (r: Row): Eval => ({
  id: str(r.id), projectId: str(r.project_id), name: str(r.name), datasetId: str(r.dataset_id), promptVersionId: strOrNull(r.prompt_version_id),
  target: j.dec<Record<string, Json> | undefined>(r.target, undefined), scorers: j.dec<ScorerConfig[]>(r.scorers, []),
  status: str(r.status) as Eval["status"], startedAt: numOrNull(r.started_at), endedAt: numOrNull(r.ended_at),
  summary: j.dec<Record<string, Json>>(r.summary, {}), baselineEvalId: strOrNull(r.baseline_eval_id), createdAt: num(r.created_at),
});
const rowResult = (r: Row): EvalResult => ({
  id: str(r.id), evalId: str(r.eval_id), itemId: str(r.item_id), output: j.dec<Json>(r.output, null), scores: j.dec<Score[]>(r.scores, []),
  latencyMs: num(r.latency_ms), costUsd: num(r.cost_usd), traceId: strOrNull(r.trace_id), error: strOrNull(r.error), createdAt: num(r.created_at),
});

export interface EvalSummary {
  items: number;
  errors: number;
  costUsd: number;
  avgLatencyMs: number;
  scores: Record<string, { mean: number; passRate: number | null; n: number }>;
}

export class EvalsRepo {
  constructor(private db: Db) {}

  create(input: { projectId: string; name: string; datasetId: string; promptVersionId?: string | null; target?: Record<string, Json>; scorers: ScorerConfig[]; baselineEvalId?: string | null }): Eval {
    const e: Eval = {
      id: newId.eval(), projectId: input.projectId, name: input.name, datasetId: input.datasetId, promptVersionId: input.promptVersionId ?? null,
      target: input.target, scorers: input.scorers, status: "pending", startedAt: null, endedAt: null, summary: {},
      baselineEvalId: input.baselineEvalId ?? null, createdAt: Date.now(),
    };
    this.db.run(
      `INSERT INTO evals (id, project_id, name, dataset_id, prompt_version_id, target, scorers, status, summary, baseline_eval_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)`,
      e.id, e.projectId, e.name, e.datasetId, e.promptVersionId, j.enc(e.target), j.enc(e.scorers), e.status, e.baselineEvalId, e.createdAt,
    );
    return e;
  }
  get(id: string): Eval | undefined {
    const r = this.db.get("SELECT * FROM evals WHERE id = ?", id);
    return r ? rowEval(r) : undefined;
  }
  list(projectId: string, limit = 100): Eval[] {
    return this.db.all("SELECT * FROM evals WHERE project_id = ? ORDER BY created_at DESC LIMIT ?", projectId, limit).map(rowEval);
  }
  setStatus(id: string, status: Eval["status"], extra: { startedAt?: number; endedAt?: number; summary?: Record<string, Json> } = {}): void {
    this.db.run(
      "UPDATE evals SET status = ?, started_at = COALESCE(?, started_at), ended_at = COALESCE(?, ended_at), summary = COALESCE(?, summary) WHERE id = ?",
      status, extra.startedAt ?? null, extra.endedAt ?? null, j.enc(extra.summary), id,
    );
  }
  addResult(input: Omit<EvalResult, "id" | "createdAt">): EvalResult {
    const r: EvalResult = { ...input, id: newId.evalResult(), createdAt: Date.now() };
    this.db.run(
      `INSERT INTO eval_results (id, eval_id, item_id, output, scores, latency_ms, cost_usd, trace_id, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      r.id, r.evalId, r.itemId, j.enc(r.output), j.enc(r.scores), r.latencyMs, r.costUsd, r.traceId, r.error, r.createdAt,
    );
    return r;
  }
  results(evalId: string): EvalResult[] {
    return this.db.all("SELECT * FROM eval_results WHERE eval_id = ? ORDER BY created_at", evalId).map(rowResult);
  }
  summarize(evalId: string): EvalSummary {
    const results = this.results(evalId);
    const scores: EvalSummary["scores"] = {};
    for (const r of results) {
      for (const s of r.scores) {
        const agg = (scores[s.name] ??= { mean: 0, passRate: null, n: 0 });
        agg.mean += s.value;
        agg.n += 1;
        if (s.passed !== undefined) agg.passRate = (agg.passRate ?? 0) + (s.passed ? 1 : 0);
      }
    }
    for (const agg of Object.values(scores)) {
      agg.mean = agg.n ? agg.mean / agg.n : 0;
      if (agg.passRate !== null) agg.passRate = agg.n ? agg.passRate / agg.n : 0;
    }
    return {
      items: results.length, errors: results.filter((r) => r.error).length,
      costUsd: results.reduce((a, r) => a + r.costUsd, 0),
      avgLatencyMs: results.length ? results.reduce((a, r) => a + r.latencyMs, 0) / results.length : 0,
      scores,
    };
  }
  /** Per-item comparison of two evals over the same dataset: regressions / improvements per scorer. */
  compare(evalId: string, baselineId: string): { regressions: Array<{ itemId: string; scorer: string; before: number; after: number }>; improvements: Array<{ itemId: string; scorer: string; before: number; after: number }> } {
    const a = new Map(this.results(baselineId).map((r) => [r.itemId, r]));
    const regressions: Array<{ itemId: string; scorer: string; before: number; after: number }> = [];
    const improvements: typeof regressions = [];
    for (const r of this.results(evalId)) {
      const base = a.get(r.itemId);
      if (!base) continue;
      for (const s of r.scores) {
        const bs = base.scores.find((x) => x.name === s.name);
        if (!bs) continue;
        if (s.value < bs.value - 1e-9) regressions.push({ itemId: r.itemId, scorer: s.name, before: bs.value, after: s.value });
        else if (s.value > bs.value + 1e-9) improvements.push({ itemId: r.itemId, scorer: s.name, before: bs.value, after: s.value });
      }
    }
    return { regressions, improvements };
  }
  delete(id: string): void {
    this.db.run("DELETE FROM evals WHERE id = ?", id);
  }
}
