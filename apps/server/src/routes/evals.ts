import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { ScorerConfig } from "@crucible/core";
import { calibrateJudge, loadEvalSpec, runEval } from "@crucible/evals";
import type { Env } from "../context.js";

export const evals = new Hono<Env>();

evals.get("/projects/:p/evals", (c) => c.json(c.var.ctx.store.evals.list(c.var.projectId).map((e) => ({ ...e, job: c.var.ctx.jobs.get(e.id) ?? null }))));

evals.post("/projects/:p/evals", async (c) => {
  const body = z.object({ name: z.string(), datasetId: z.string(), promptVersionId: z.string().nullable().optional(), target: z.record(z.any()).optional(), scorers: z.array(ScorerConfig).min(1), baselineEvalId: z.string().nullable().optional(), run: z.boolean().optional() }).parse(await c.req.json());
  const ev = c.var.ctx.store.evals.create({ projectId: c.var.projectId, ...body });
  if (body.run) startEval(c.var.ctx, ev.id);
  return c.json(ev, 201);
});

/** Create from a declarative spec (same format as the CLI / CI). */
evals.post("/projects/:p/evals/spec", async (c) => {
  const spec = await c.req.json();
  const project = c.var.ctx.store.workbench.getProject(c.var.projectId)!;
  const { evalId } = loadEvalSpec(c.var.ctx.store, { ...spec, project: project.slug });
  if (c.req.query("run") !== "false") startEval(c.var.ctx, evalId);
  return c.json(c.var.ctx.store.evals.get(evalId), 201);
});

/** Judge calibration against a human-labelled golden dataset. */
evals.post("/projects/:p/evals/calibrate", async (c) => {
  const body = z.object({ datasetId: z.string(), judge: z.object({ model: z.string(), rubric: z.string(), scale: z.tuple([z.number(), z.number()]).default([0, 1]), passThreshold: z.number().optional() }), concurrency: z.number().int().positive().optional() }).parse(await c.req.json());
  const report = await calibrateJudge({ store: c.var.ctx.store, gateway: c.var.ctx.gateway, projectId: c.var.projectId, datasetId: body.datasetId, judge: { type: "llm_judge", runIf: "always", ...body.judge }, concurrency: body.concurrency });
  c.var.ctx.store.ops.audit({ projectId: c.var.projectId, actor: c.var.actor, action: "eval.calibrate", targetType: "dataset", targetId: body.datasetId, details: { n: report.n, agreement: report.agreement, kappa: report.kappa } });
  return c.json(report);
});

evals.get("/evals/:id", (c) => {
  const s = c.var.ctx.store;
  const ev = s.evals.get(c.req.param("id"));
  if (!ev) return c.json({ error: "not found" }, 404);
  const items = new Map(s.workbench.listItems(ev.datasetId).map((i) => [i.id, i]));
  const results = s.evals.results(ev.id).map((r) => ({ ...r, item: items.get(r.itemId) ?? null }));
  const compare = ev.baselineEvalId ? s.evals.compare(ev.id, ev.baselineEvalId) : null;
  return c.json({ ...ev, summary: s.evals.summarize(ev.id), results, compare, job: c.var.ctx.jobs.get(ev.id) ?? null, promptVersion: ev.promptVersionId ? s.workbench.getVersion(ev.promptVersionId) : null });
});
evals.post("/evals/:id/run", (c) => { startEval(c.var.ctx, c.req.param("id")); return c.json({ ok: true }); });
evals.get("/evals/:id/compare/:baseline", (c) => c.json(c.var.ctx.store.evals.compare(c.req.param("id"), c.req.param("baseline"))));
evals.delete("/evals/:id", (c) => { c.var.ctx.store.evals.delete(c.req.param("id")); return c.body(null, 204); });

evals.get("/evals/:id/progress", (c) => {
  const id = c.req.param("id");
  return streamSSE(c, async (stream) => {
    const send = (data: unknown) => stream.writeSSE({ event: "progress", data: JSON.stringify(data) });
    const cur = c.var.ctx.jobs.get(id);
    if (cur) await send(cur);
    let open = true;
    const unsub = c.var.ctx.bus.subscribe(`eval:${id}`, (d) => { void send(d); if ((d as { status: string }).status !== "running") open = false; });
    stream.onAbort(() => { open = false; unsub(); });
    while (open) await stream.sleep(500);
    unsub();
  });
});

export function startEval(ctx: Env["Variables"]["ctx"], evalId: string) {
  if (ctx.jobs.get(evalId)?.status === "running") return;
  ctx.jobs.set(evalId, { done: 0, total: 0, status: "running" });
  void runEval({
    store: ctx.store, gateway: ctx.gateway, evalId,
    onProgress: (p) => { const j = { done: p.done, total: p.total, status: "running" }; ctx.jobs.set(evalId, j); ctx.bus.publish(`eval:${evalId}`, j); },
  })
    .then((r) => { const j = { done: r.summary.items, total: r.summary.items, status: "completed" }; ctx.jobs.set(evalId, j); ctx.bus.publish(`eval:${evalId}`, { ...j, passed: r.passed }); })
    .catch((err: Error) => { ctx.store.evals.setStatus(evalId, "failed", { endedAt: Date.now(), summary: { error: err.message } }); const j = { done: 0, total: 0, status: "failed", error: err.message }; ctx.jobs.set(evalId, j); ctx.bus.publish(`eval:${evalId}`, j); });
}
