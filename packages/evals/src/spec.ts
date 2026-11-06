import { z } from "zod";
import { ScorerConfig, type Store } from "@crucible/core";

/** Declarative eval file (JSON or YAML-ish JSON) used by the CLI and CI. */
export const EvalSpec = z.object({
  name: z.string(),
  project: z.string().default("default"),
  dataset: z.union([
    z.string(),
    z.object({ name: z.string(), items: z.array(z.object({ input: z.record(z.any()), expected: z.any().optional(), metadata: z.record(z.any()).optional() })) }),
  ]),
  /** `promptName@label|version` or inline template */
  prompt: z.union([z.string(), z.object({ name: z.string(), template: z.array(z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string() })), model: z.string(), temperature: z.number().optional(), maxTokens: z.number().optional() })]).optional(),
  target: z.object({ url: z.string(), headers: z.record(z.string()).optional() }).optional(),
  scorers: z.array(ScorerConfig).min(1),
  baseline: z.string().optional(),
  concurrency: z.number().int().positive().optional(),
});
export type EvalSpecT = z.infer<typeof EvalSpec>;

/** Materialize a spec into stored dataset / prompt version / eval rows and return the eval id. */
export function loadEvalSpec(store: Store, raw: unknown): { evalId: string; projectId: string } {
  const spec = EvalSpec.parse(raw);
  const project = store.workbench.getProject(spec.project) ?? store.workbench.createProject(spec.project);
  let datasetId: string;
  if (typeof spec.dataset === "string") {
    const ds = store.workbench.getDataset(project.id, spec.dataset);
    if (!ds) throw new Error(`dataset not found: ${spec.dataset}`);
    datasetId = ds.id;
  } else {
    const existing = store.workbench.getDataset(project.id, spec.dataset.name);
    const ds = existing ?? store.workbench.createDataset(project.id, spec.dataset.name);
    if (!existing) store.workbench.addItems(ds.id, spec.dataset.items);
    datasetId = ds.id;
  }
  let promptVersionId: string | null = null;
  if (typeof spec.prompt === "string") {
    const v = store.workbench.resolveVersion(project.id, spec.prompt);
    if (!v) throw new Error(`prompt not found: ${spec.prompt}`);
    promptVersionId = v.id;
  } else if (spec.prompt) {
    const p = store.workbench.getPrompt(project.id, spec.prompt.name) ?? store.workbench.createPrompt(project.id, spec.prompt.name);
    const latest = store.workbench.listVersions(p.id)[0];
    const same = latest && JSON.stringify(latest.template) === JSON.stringify(spec.prompt.template) && latest.config.model === spec.prompt.model;
    const v = same ? latest : store.workbench.createVersion(p.id, { template: spec.prompt.template, config: { model: spec.prompt.model, temperature: spec.prompt.temperature, maxTokens: spec.prompt.maxTokens }, commitMessage: `from eval spec ${spec.name}` });
    promptVersionId = v.id;
  }
  let baselineEvalId: string | null = null;
  if (spec.baseline === "latest") baselineEvalId = store.evals.list(project.id).find((e) => e.name === spec.name && e.status === "completed")?.id ?? null;
  else if (spec.baseline) baselineEvalId = spec.baseline;
  const ev = store.evals.create({ projectId: project.id, name: spec.name, datasetId, promptVersionId, target: spec.target, scorers: spec.scorers, baselineEvalId });
  return { evalId: ev.id, projectId: project.id };
}
