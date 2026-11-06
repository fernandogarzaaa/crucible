import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { AlertRule } from "@crucible/core";
import type { Env } from "../context.js";

export const ops = new Hono<Env>();

ops.get("/projects/:p/approvals", (c) => c.json(c.var.ctx.store.ops.listApprovals(c.var.projectId, c.req.query("status") as never)));
ops.post("/approvals/:id/resolve", async (c) => {
  const body = z.object({ status: z.enum(["approved", "rejected"]), reason: z.string().optional() }).parse(await c.req.json());
  const a = c.var.ctx.store.ops.resolveApproval(c.req.param("id"), body.status, c.var.actor, body.reason);
  if (!a) return c.json({ error: "not found" }, 404);
  c.var.ctx.store.ops.audit({ projectId: a.projectId, actor: c.var.actor, action: `approval.${body.status}`, targetType: "approval", targetId: a.id, details: { runId: a.runId, reason: body.reason ?? null } });
  c.var.ctx.bus.publish(`approvals:${a.projectId}`, a);
  return c.json(a);
});
ops.get("/projects/:p/audit", (c) => c.json(c.var.ctx.store.ops.auditLog(c.var.projectId, Number(c.req.query("limit") ?? 200))));

ops.get("/projects/:p/alerts", (c) => c.json(c.var.ctx.store.ops.listAlerts(c.var.projectId).map((a) => ({ ...a, current: evaluateAlert(c.var.ctx, a) }))));
ops.post("/projects/:p/alerts", async (c) => {
  const body = z.object({ name: z.string(), metric: z.enum(["error_rate", "cost_usd", "latency_p95_ms", "requests", "approval_pending_count"]), op: z.enum([">", ">=", "<", "<="]), threshold: z.number(), windowMinutes: z.number().int().positive().default(60), enabled: z.boolean().optional() }).parse(await c.req.json());
  return c.json(c.var.ctx.store.ops.createAlert({ projectId: c.var.projectId, ...body }), 201);
});
ops.delete("/alerts/:id", (c) => { c.var.ctx.store.ops.deleteAlert(c.req.param("id")); return c.body(null, 204); });

/** Everything the home dashboard needs in one round-trip. */
ops.get("/projects/:p/overview", (c) => {
  const s = c.var.ctx.store, p = c.var.projectId;
  const windowMs = Number(c.req.query("windowMs") ?? 24 * 3600_000);
  const alerts = s.ops.listAlerts(p).map((a) => ({ ...a, current: evaluateAlert(c.var.ctx, a) }));
  return c.json({
    traces: s.tracing.stats(p, windowMs), gateway: s.gateway.stats(p, windowMs), fleet: s.agents.fleet(p, windowMs),
    pendingApprovals: s.ops.listApprovals(p, "pending").length, budgets: s.gateway.listBudgets(p),
    firingAlerts: alerts.filter((a) => a.current.firing), recentEvals: s.evals.list(p, 5), recentRuns: s.agents.listRuns(p, { limit: 8 }),
    counts: { prompts: s.workbench.listPrompts(p).length, datasets: s.workbench.listDatasets(p).length, kbs: s.rag.listKbs(p).length },
  });
});

/** Live feed of everything happening in a project (runs, approvals, traces). */
ops.get("/projects/:p/live", (c) => {
  const p = c.var.projectId;
  return streamSSE(c, async (stream) => {
    let open = true;
    const subs = [`runs:${p}`, `approvals:${p}`, `traces:${p}`].map((t) => c.var.ctx.bus.subscribe(t, (d) => void stream.writeSSE({ event: t.split(":")[0]!, data: JSON.stringify(d) })));
    stream.onAbort(() => { open = false; subs.forEach((u) => u()); });
    while (open) { await stream.writeSSE({ event: "ping", data: String(Date.now()) }); await stream.sleep(15_000); }
  });
});

export function evaluateAlert(ctx: Env["Variables"]["ctx"], a: AlertRule): { value: number; firing: boolean } {
  const windowMs = a.windowMinutes * 60_000;
  const t = ctx.store.tracing.stats(a.projectId, windowMs);
  const g = ctx.store.gateway.stats(a.projectId, windowMs);
  let value = 0;
  switch (a.metric) {
    case "error_rate": value = (t.traces + g.requests) ? (t.errors + g.errors) / (t.traces + g.requests) : 0; break;
    case "cost_usd": value = g.costUsd; break;
    case "latency_p95_ms": value = t.p95Ms; break;
    case "requests": value = g.requests; break;
    case "approval_pending_count": value = ctx.store.ops.listApprovals(a.projectId, "pending").length; break;
  }
  const firing = a.enabled && ({ ">": value > a.threshold, ">=": value >= a.threshold, "<": value < a.threshold, "<=": value <= a.threshold })[a.op];
  if (firing && (!a.lastFiredAt || Date.now() - a.lastFiredAt > windowMs)) { ctx.store.ops.markFired(a.id); ctx.store.ops.audit({ projectId: a.projectId, actor: "system", action: "alert.fire", targetType: "alert", targetId: a.id, details: { value, threshold: a.threshold } }); }
  return { value, firing };
}
