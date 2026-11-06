import { describe, expect, it } from "vitest";
import { Store } from "@crucible/core";
import { Gateway, MockProvider } from "@crucible/gateway";
import { runEval } from "./runner.js";
import { loadEvalSpec } from "./spec.js";
import { validateJsonSchema, levenshtein } from "./scorers.js";

describe("evals", () => {
  it("runs a spec end to end with a prompt target and a judge, then detects regressions", async () => {
    const store = Store.memory();
    const provider = new MockProvider({ reply: (req) => {
      const text = JSON.stringify(req.messages);
      if (text.includes("strict evaluator")) return '{"score": 5, "reason": "fine"}';
      return text.includes("Paris") ? "The capital is Paris." : "I do not know.";
    } });
    const gateway = new Gateway({ providers: [provider], store });
    const { evalId } = loadEvalSpec(store, {
      name: "capitals",
      dataset: { name: "capitals", items: [
        { input: { q: "Capital of France? Paris?" }, expected: "Paris" },
        { input: { q: "Capital of Peru?" }, expected: "Lima" },
      ] },
      prompt: { name: "qa", template: [{ role: "user", content: "{{q}}" }], model: "mock-fast" },
      scorers: [{ type: "contains" }, { type: "llm_judge", model: "mock-fast", rubric: "Is it correct?", scale: [1, 5], passThreshold: 4 }, { type: "latency", maxMs: 5000 }],
    });
    const report = await runEval({ store, gateway, evalId });
    expect(report.summary.items).toBe(2);
    expect(report.summary.scores.contains?.passRate).toBe(0.5);
    expect(report.summary.scores.llm_judge?.mean).toBe(1);
    expect(report.passed).toBe(false);
    const traces = store.tracing.listTraces({ projectId: report.eval.projectId, tag: "eval" });
    expect(traces).toHaveLength(2);

    // Second run against the first as baseline, with a worse model: regression detected.
    const worse = new MockProvider({ reply: (req) => (JSON.stringify(req.messages).includes("strict evaluator") ? '{"score": 1}' : "nope") });
    const gw2 = new Gateway({ providers: [worse], store });
    const second = loadEvalSpec(store, { name: "capitals", dataset: "capitals", prompt: "qa", baseline: "latest", scorers: [{ type: "contains" }] });
    const r2 = await runEval({ store, gateway: gw2, evalId: second.evalId });
    expect(r2.regressions).toBe(1);
    store.close();
  });

  it("validates json schema subset and computes levenshtein", () => {
    expect(validateJsonSchema({ a: 1 }, { type: "object", required: ["a", "b"], properties: { a: { type: "string" } } })).toHaveLength(2);
    expect(validateJsonSchema([1, 2], { type: "array", items: { type: "integer" } })).toHaveLength(0);
    expect(levenshtein("kitten", "sitting")).toBe(3);
  });
});
