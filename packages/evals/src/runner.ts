import { renderTemplate, type Eval, type EvalSummary, type Json, type Score, type ScorerConfig, type Store } from "@crucible/core";
import type { Gateway } from "@crucible/gateway";
import { buildScorer, type Scorer } from "./scorers.js";

export interface TargetResult { output: Json; costUsd?: number; traceId?: string | null; metadata?: Record<string, Json> }
export type Target = (input: Record<string, Json>, ctx: { itemId: string; evalId: string; projectId: string }) => Promise<TargetResult>;

export interface RunOptions {
  store: Store;
  gateway?: Gateway;
  evalId: string;
  target?: Target;
  concurrency?: number;
  onProgress?: (p: { done: number; total: number; itemId: string; error?: string }) => void;
  signal?: AbortSignal;
}

export interface RunReport { eval: Eval; summary: EvalSummary; regressions: number; improvements: number; passed: boolean; warnings: string[] }

/** Target that renders a stored prompt version and calls it through the gateway with full tracing. */
export function promptVersionTarget(store: Store, gateway: Gateway, promptVersionId: string): Target {
  const version = store.workbench.getVersion(promptVersionId);
  if (!version) throw new Error(`prompt version not found: ${promptVersionId}`);
  return async (input, ctx) => {
    const trace = store.tracing.startTrace({ projectId: ctx.projectId, name: `eval:${ctx.evalId}`, input, metadata: { evalId: ctx.evalId, itemId: ctx.itemId, promptVersionId }, tags: ["eval"] });
    const span = store.tracing.startSpan({ traceId: trace.id, name: "llm", kind: "llm", model: version.config.model, input: renderTemplate(version.template, input) });
    try {
      const res = await gateway.chat({ messages: renderTemplate(version.template, input), config: version.config, metadata: { evalId: ctx.evalId } }, { projectId: ctx.projectId, traceId: trace.id, scopes: ["project"] });
      const text = typeof res.message.content === "string" ? res.message.content : res.message.content.map((p) => (p.type === "text" ? p.text : p.type === "tool_use" ? JSON.stringify({ tool: p.name, input: p.input }) : "")).join("");
      store.tracing.endSpan(span.id, { output: text, usage: res.usage, costUsd: res.costUsd, model: res.model, attributes: { provider: res.provider, cached: res.cached } });
      store.tracing.endTrace(trace.id, { output: text });
      return { output: text, costUsd: res.costUsd, traceId: trace.id };
    } catch (err) {
      store.tracing.endSpan(span.id, { error: (err as Error).message });
      store.tracing.endTrace(trace.id, { status: "error" });
      throw err;
    }
  };
}

/** Target that POSTs the input to an HTTP endpoint and treats the JSON (or text) body as the output. */
export function httpTarget(url: string, headers: Record<string, string> = {}): Target {
  return async (input) => {
    const t0 = Date.now();
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(input) });
    const text = await res.text();
    let output: Json = text;
    try { output = JSON.parse(text) as Json; } catch { /* keep text */ }
    if (!res.ok) throw new Error(`target ${res.status}: ${text.slice(0, 200)}`);
    return { output, metadata: { httpLatencyMs: Date.now() - t0 } };
  };
}

export async function runEval(opts: RunOptions): Promise<RunReport> {
  const { store, evalId } = opts;
  const ev = store.evals.get(evalId);
  if (!ev) throw new Error(`eval not found: ${evalId}`);
  const items = store.workbench.listItems(ev.datasetId);
  const target: Target = opts.target ?? (() => {
    if (ev.promptVersionId && opts.gateway) return promptVersionTarget(store, opts.gateway, ev.promptVersionId);
    if (ev.target?.url) return httpTarget(String(ev.target.url), (ev.target.headers as Record<string, string>) ?? {});
    throw new Error("eval has no runnable target: provide a prompt version + gateway, an HTTP target, or a custom target function");
  })();
  // Deterministic scorers run first so judges can be gated on them (and so invalid outputs never cost judge calls).
  const ordered = [...ev.scorers].sort((a, b) => Number(a.type === "llm_judge") - Number(b.type === "llm_judge"));
  const scorers: Array<{ cfg: ScorerConfig; scorer: Scorer }> = ordered.map((c) => ({ cfg: c, scorer: buildScorer(c, { gateway: opts.gateway, projectId: ev.projectId }) }));
  const warnings: string[] = [];
  const targetModel = ev.promptVersionId ? store.workbench.getVersion(ev.promptVersionId)?.config.model : undefined;
  for (const c of ev.scorers) {
    if (c.type === "llm_judge" && targetModel && c.model === targetModel) warnings.push(`judge model "${c.model}" is the same as the model under test; LLM judges prefer their own outputs (self-preference bias). Use a different judge model.`);
    if (c.type === "llm_judge" && c.passThreshold === undefined) warnings.push(`llm_judge has no passThreshold, so it contributes a score but never a pass/fail; set passThreshold to use it as a release gate.`);
  }

  store.evals.setStatus(evalId, "running", { startedAt: Date.now() });
  let done = 0;
  const queue = [...items];
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      if (opts.signal?.aborted) return;
      const t0 = Date.now();
      let output: Json = null, costUsd = 0, traceId: string | null = null, error: string | null = null;
      try {
        const r = await target(item.input, { itemId: item.id, evalId, projectId: ev.projectId });
        output = r.output; costUsd = r.costUsd ?? 0; traceId = r.traceId ?? null;
      } catch (err) { error = (err as Error).message ?? String(err); }
      const latencyMs = Date.now() - t0;
      const scores: Score[] = [];
      if (!error) {
        const ctx = { input: item.input, output, expected: item.expected, latencyMs, costUsd, metadata: item.metadata };
        let preflightPassed = true;
        for (const { cfg, scorer } of scorers) {
          if (cfg.type === "llm_judge" && cfg.runIf === "preflight_passed" && !preflightPassed) { scores.push({ name: scorer.name, value: 0, passed: false, reason: "skipped: deterministic checks failed" }); continue; }
          const sc = await scorer.score(ctx).catch((e: Error) => ({ name: scorer.name, value: 0, passed: false, reason: `scorer error: ${e.message}` }));
          scores.push(sc);
          if (cfg.type !== "llm_judge" && sc.passed === false) preflightPassed = false;
        }
      }
      store.evals.addResult({ evalId, itemId: item.id, output, scores, latencyMs, costUsd, traceId, error });
      done++;
      opts.onProgress?.({ done, total: items.length, itemId: item.id, error: error ?? undefined });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 4, items.length || 1)) }, worker));

  const summary = store.evals.summarize(evalId);
  const cmp = ev.baselineEvalId ? store.evals.compare(evalId, ev.baselineEvalId) : { regressions: [], improvements: [] };
  const passRates = Object.values(summary.scores).map((s) => s.passRate).filter((x): x is number => x !== null);
  const passed = summary.errors === 0 && cmp.regressions.length === 0 && passRates.every((p) => p === 1);
  const status = opts.signal?.aborted ? "cancelled" : "completed";
  store.evals.setStatus(evalId, status, { endedAt: Date.now(), summary: { ...(summary as unknown as Record<string, Json>), regressions: cmp.regressions.length, improvements: cmp.improvements.length, passed, warnings } });
  return { eval: store.evals.get(evalId)!, summary, regressions: cmp.regressions.length, improvements: cmp.improvements.length, passed, warnings };
}
