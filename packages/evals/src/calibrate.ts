import type { Json, ScorerConfig, Store } from "@crucible/core";
import type { Gateway } from "@crucible/gateway";
import { buildScorer } from "./scorers.js";

/**
 * Judge calibration against a human-labelled golden set (Promptfoo / Hamel Husain practice).
 * Golden dataset items: `input` is the original task input, `metadata.output` is the candidate response
 * the human reviewed, and `expected` is the human verdict: true/false, "pass"/"fail", or { pass, critique }.
 * Reports agreement, true-positive / true-negative rates (more honest than raw agreement when failures
 * are rare), Cohen's kappa, and every disagreement with the judge's reason so the rubric can be refined.
 */
export interface CalibrationReport {
  n: number;
  agreement: number;
  kappa: number;
  truePositiveRate: number | null;
  trueNegativeRate: number | null;
  confusion: { tp: number; tn: number; fp: number; fn: number };
  judgeCostUsd: number;
  disagreements: Array<{ itemId: string; human: boolean; judge: boolean; score: number; reason?: string; critique?: string; output: string }>;
  advice: string[];
}

const humanVerdict = (expected: Json | undefined): { pass: boolean; critique?: string } | null => {
  if (typeof expected === "boolean") return { pass: expected };
  if (typeof expected === "string") return /^(pass|true|yes|ok|1)$/i.test(expected.trim()) ? { pass: true } : /^(fail|false|no|0)$/i.test(expected.trim()) ? { pass: false } : null;
  if (expected && typeof expected === "object" && !Array.isArray(expected) && typeof (expected as { pass?: unknown }).pass === "boolean") return { pass: (expected as { pass: boolean }).pass, critique: (expected as { critique?: string }).critique };
  return null;
};

export async function calibrateJudge(opts: { store: Store; gateway: Gateway; projectId: string; datasetId: string; judge: Extract<ScorerConfig, { type: "llm_judge" }>; concurrency?: number }): Promise<CalibrationReport> {
  const judge = { ...opts.judge, passThreshold: opts.judge.passThreshold ?? (opts.judge.scale[0] + opts.judge.scale[1]) / 2 };
  const scorer = buildScorer(judge, { gateway: opts.gateway, projectId: opts.projectId });
  const items = opts.store.workbench.listItems(opts.datasetId).filter((it) => humanVerdict(it.expected) !== null);
  const before = opts.store.gateway.stats(opts.projectId, 10 * 60_000).costUsd;
  const results: Array<{ itemId: string; human: { pass: boolean; critique?: string }; judge: boolean; score: number; reason?: string; output: string }> = [];
  const queue = [...items];
  const worker = async () => {
    for (let it = queue.shift(); it; it = queue.shift()) {
      const human = humanVerdict(it.expected)!;
      const output = (it.metadata?.output ?? it.metadata?.response ?? "") as Json;
      const sc = await scorer.score({ input: it.input, output, expected: undefined, latencyMs: 0, costUsd: 0, metadata: it.metadata });
      results.push({ itemId: it.id, human, judge: sc.passed === true, score: sc.value, reason: sc.reason, output: typeof output === "string" ? output : JSON.stringify(output) });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 4, items.length || 1)) }, worker));
  const c = { tp: 0, tn: 0, fp: 0, fn: 0 };
  for (const r of results) { if (r.human.pass && r.judge) c.tp++; else if (!r.human.pass && !r.judge) c.tn++; else if (!r.human.pass && r.judge) c.fp++; else c.fn++; }
  const n = results.length;
  const agreement = n ? (c.tp + c.tn) / n : 0;
  const pHumanPass = n ? (c.tp + c.fn) / n : 0, pJudgePass = n ? (c.tp + c.fp) / n : 0;
  const pe = pHumanPass * pJudgePass + (1 - pHumanPass) * (1 - pJudgePass);
  const kappa = pe === 1 ? 1 : (agreement - pe) / (1 - pe);
  const tpr = c.tp + c.fn ? c.tp / (c.tp + c.fn) : null, tnr = c.tn + c.fp ? c.tn / (c.tn + c.fp) : null;
  const advice: string[] = [];
  if (n < 60) advice.push(`only ${n} labelled examples; below ~60 the confidence intervals are too wide to trust. Aim for ~100 per failure mode.`);
  if (agreement < 0.9) advice.push(`agreement ${(agreement * 100).toFixed(0)}% is below the 90% bar; refine the rubric using the disagreements below (use critiques as few-shot examples) and re-run.`);
  if (tnr !== null && tnr < 0.8) advice.push("the judge passes outputs humans failed (low true-negative rate); make the rubric's failure conditions explicit.");
  if (tpr !== null && tpr < 0.8) advice.push("the judge fails outputs humans passed (low true-positive rate); the rubric may be penalising style rather than content.");
  if (kappa < 0.6 && n >= 20) advice.push(`Cohen's kappa ${kappa.toFixed(2)} indicates weak agreement beyond chance even if raw agreement looks fine.`);
  if (!advice.length) advice.push("judge is calibrated; pin the judge model version and re-run this set weekly to catch drift.");
  return {
    n, agreement, kappa, truePositiveRate: tpr, trueNegativeRate: tnr, confusion: c,
    judgeCostUsd: Math.max(0, opts.store.gateway.stats(opts.projectId, 10 * 60_000).costUsd - before),
    disagreements: results.filter((r) => r.human.pass !== r.judge).map((r) => ({ itemId: r.itemId, human: r.human.pass, judge: r.judge, score: r.score, reason: r.reason, critique: r.human.critique, output: r.output.slice(0, 400) })),
    advice,
  };
}
