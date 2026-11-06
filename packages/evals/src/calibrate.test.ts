import { describe, expect, it } from "vitest";
import { Store } from "@crucible/core";
import { Gateway, MockProvider } from "@crucible/gateway";
import { calibrateJudge } from "./calibrate.js";
import { runEval } from "./runner.js";
import { loadEvalSpec } from "./spec.js";

const judgeProvider = () => new MockProvider({ reply: (req) => {
  const text = JSON.stringify(req.messages);
  if (text.includes("strict evaluator")) return text.includes("RESPONSE:\\nParis") ? '{"score": 5, "reason": "correct"}' : '{"score": 1, "reason": "wrong"}';
  return "Paris";
} });

describe("judge calibration and gating", () => {
  it("computes agreement, rates, kappa and lists disagreements", async () => {
    const store = Store.memory();
    const p = store.workbench.ensureDefaultProject();
    const gateway = new Gateway({ providers: [judgeProvider()], store });
    const ds = store.workbench.createDataset(p.id, "golden");
    store.workbench.addItems(ds.id, [
      { input: { q: "capital of France" }, metadata: { output: "Paris" }, expected: true },
      { input: { q: "capital of France" }, metadata: { output: "Lyon" }, expected: false },
      { input: { q: "capital of France" }, metadata: { output: "Paris" }, expected: { pass: false, critique: "human says too terse" } },
      { input: { q: "capital of France" }, metadata: { output: "Berlin" }, expected: "fail" },
    ]);
    const report = await calibrateJudge({ store, gateway, projectId: p.id, datasetId: ds.id, judge: { type: "llm_judge", model: "mock-fast", rubric: "correct?", scale: [1, 5], passThreshold: 4, runIf: "always" } });
    expect(report.n).toBe(4);
    expect(report.confusion).toEqual({ tp: 1, tn: 2, fp: 1, fn: 0 });
    expect(report.agreement).toBe(0.75);
    expect(report.trueNegativeRate).toBeCloseTo(2 / 3);
    expect(report.disagreements).toHaveLength(1);
    expect(report.disagreements[0]!.critique).toBe("human says too terse");
    expect(report.advice.some((a) => a.includes("labelled examples"))).toBe(true);
  });

  it("skips the judge when deterministic checks fail and warns about self-judging", async () => {
    const store = Store.memory();
    const provider = judgeProvider();
    const gateway = new Gateway({ providers: [provider], store });
    const { evalId } = loadEvalSpec(store, {
      name: "gated", dataset: { name: "d", items: [{ input: { q: "x" }, expected: "Paris" }, { input: { q: "y" }, expected: "Lima" }] },
      prompt: { name: "p", template: [{ role: "user", content: "{{q}}" }], model: "mock-fast" },
      scorers: [{ type: "llm_judge", model: "mock-fast", rubric: "r", scale: [1, 5], passThreshold: 4, runIf: "preflight_passed" }, { type: "contains" }],
    });
    const callsBefore = provider.calls;
    const report = await runEval({ store, gateway, evalId });
    const results = store.evals.results(evalId);
    expect(results.every((r) => r.scores[0]!.name === "contains")).toBe(true); // deterministic first
    const skipped = results.flatMap((r) => r.scores).filter((s) => s.reason?.startsWith("skipped"));
    expect(skipped).toHaveLength(1);
    expect(provider.calls - callsBefore).toBe(3); // 2 target calls + 1 judge call (the Lima item was gated)
    expect(report.warnings.some((w) => w.includes("self-preference"))).toBe(true);
  });
});
