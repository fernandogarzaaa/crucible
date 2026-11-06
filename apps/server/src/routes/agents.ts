import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { diffRuns } from "@crucible/agents";
import type { Env } from "../context.js";

export const agents = new Hono<Env>();

agents.get("/agents", (c) => c.json(c.var.ctx.agents.list()));

agents.post("/projects/:p/agents/:name/run", async (c) => {
  const def = c.var.ctx.agents.get(c.req.param("name"));
  if (!def) return c.json({ error: "agent not registered on this server" }, 404);
  const body = z.object({ input: z.string(), metadata: z.record(z.any()).optional() }).parse(await c.req.json());
  const ctx = c.var.ctx;
  const started = new Promise<string>((resolve) => {
    void ctx.runtime.run(def, {
      projectId: c.var.projectId, input: body.input, metadata: { ...(body.metadata ?? {}), startedBy: c.var.actor },
      onEvent: (ev) => { if (ev.type === "run_started") resolve(ev.runId); ctx.bus.publish(`run:${ev.runId}`, ev); ctx.bus.publish(`runs:${c.var.projectId}`, ev); },
    }).catch((err: Error) => ctx.bus.publish(`runs:${c.var.projectId}`, { type: "error", message: err.message }));
  });
  const runId = await started;
  return c.json({ runId }, 202);
});

agents.get("/projects/:p/runs", (c) => {
  const q = c.req.query();
  return c.json(c.var.ctx.store.agents.listRuns(c.var.projectId, { status: q.status as never, agentName: q.agent, limit: q.limit ? Number(q.limit) : 100 }));
});
agents.get("/projects/:p/fleet", (c) => c.json(c.var.ctx.store.agents.fleet(c.var.projectId, Number(c.req.query("windowMs") ?? 24 * 3600_000))));

agents.get("/runs/:id", (c) => {
  const s = c.var.ctx.store;
  const run = s.agents.getRun(c.req.param("id"));
  if (!run) return c.json({ error: "not found" }, 404);
  return c.json({ ...run, events: s.agents.events(run.id), children: s.agents.children(run.id), approvals: s.ops.listApprovals(run.projectId).filter((a) => a.runId === run.id), registered: !!c.var.ctx.agents.get(run.agentName) });
});

agents.get("/runs/:id/stream", (c) => {
  const id = c.req.param("id");
  return streamSSE(c, async (stream) => {
    for (const ev of c.var.ctx.store.agents.events(id)) await stream.writeSSE({ event: "event", data: JSON.stringify(ev) });
    let open = !["completed", "failed", "killed"].includes(c.var.ctx.store.agents.getRun(id)?.status ?? "completed");
    const unsub = c.var.ctx.bus.subscribe(`run:${id}`, (ev) => { void stream.writeSSE({ event: "event", data: JSON.stringify(ev) }); if ((ev as { type: string }).type === "run_finished" || (ev as { type: string }).type === "error") open = false; });
    stream.onAbort(() => { open = false; unsub(); });
    while (open) await stream.sleep(300);
    unsub();
  });
});

/** Live fork: resume a registered agent from a step, optionally patching one recorded event. */
agents.post("/runs/:id/fork", async (c) => {
  const s = c.var.ctx.store;
  const src = s.agents.getRun(c.req.param("id"));
  if (!src) return c.json({ error: "not found" }, 404);
  const body = z.object({ atSeq: z.number().int().nonnegative(), replaceEvent: z.object({ seq: z.number().int(), payload: z.unknown().transform((v) => v ?? null) }).optional(), model: z.string().optional(), live: z.boolean().default(true), replayMatch: z.enum(["input", "order"]).optional(), replayBoundaries: z.array(z.enum(["llm", "tool"])).min(1).optional() }).parse(await c.req.json());
  const def = c.var.ctx.agents.get(src.agentName);
  if (!body.live || !def) {
    const fork = s.agents.fork(src.id, body.atSeq, { replaceEvent: body.replaceEvent });
    return c.json({ runId: fork.id, live: false }, 202);
  }
  const ctx = c.var.ctx;
  const effectiveDef = body.model ? { ...def, model: { ...def.model, model: body.model } } : def;
  const runId = await new Promise<string>((resolve) => {
    void ctx.runtime.fork(effectiveDef, src.id, body.atSeq, {
      replaceEvent: body.replaceEvent, replayMatch: body.replayMatch, replayBoundaries: body.replayBoundaries, metadata: { forkedBy: c.var.actor, modelOverride: body.model ?? null },
      onEvent: (ev) => { if (ev.type === "run_started") resolve(ev.runId); ctx.bus.publish(`run:${ev.runId}`, ev); ctx.bus.publish(`runs:${src.projectId}`, ev); },
    }).catch((err: Error) => ctx.bus.publish(`runs:${src.projectId}`, { type: "error", message: err.message }));
  });
  s.ops.audit({ projectId: src.projectId, actor: c.var.actor, action: "agent.fork", targetType: "agent_run", targetId: src.id, details: { atSeq: body.atSeq, newRunId: runId } });
  return c.json({ runId, live: true }, 202);
});

agents.post("/runs/:id/replay", async (c) => {
  const opts = z.object({ replayMatch: z.enum(["input", "order"]).optional(), replayBoundaries: z.array(z.enum(["llm", "tool"])).min(1).optional() }).parse(await c.req.json().catch(() => ({})));
  const s = c.var.ctx.store;
  const src = s.agents.getRun(c.req.param("id"));
  if (!src) return c.json({ error: "not found" }, 404);
  const def = c.var.ctx.agents.get(src.agentName);
  if (!def) return c.json({ error: "agent not registered; only registered agents can be replayed live" }, 409);
  const ctx = c.var.ctx;
  const runId = await new Promise<string>((resolve) => {
    void ctx.runtime.replay(def, src.id, { ...opts, onEvent: (ev) => { if (ev.type === "run_started") resolve(ev.runId); ctx.bus.publish(`run:${ev.runId}`, ev); } }).catch(() => undefined);
  });
  return c.json({ runId }, 202);
});

agents.post("/runs/:id/kill", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  c.var.ctx.runtime.kill(c.req.param("id"), c.var.actor, (body as { reason?: string }).reason);
  return c.json({ ok: true });
});
agents.get("/runs/:id/diff/:other", (c) => c.json(diffRuns(c.var.ctx.store, c.req.param("id"), c.req.param("other"))));
agents.delete("/runs/:id", (c) => { c.var.ctx.store.agents.deleteRun(c.req.param("id")); return c.body(null, 204); });

/** Ingest events for runs recorded by external agents (through the SDK or any HTTP client). */
agents.post("/projects/:p/runs/ingest", async (c) => {
  const body = z.object({ runId: z.string().optional(), agentName: z.string(), status: z.enum(["running", "completed", "failed"]).optional(), metadata: z.record(z.any()).optional(), events: z.array(z.object({ type: z.string(), payload: z.any(), spanId: z.string().nullable().optional() })) }).parse(await c.req.json());
  const s = c.var.ctx.store;
  const run = (body.runId && s.agents.getRun(body.runId)) || s.agents.createRun({ id: body.runId, projectId: c.var.projectId, agentName: body.agentName, metadata: body.metadata ?? {} });
  for (const e of body.events) { const ev = s.agents.appendEvent(run.id, e.type as never, e.payload, e.spanId ?? null); c.var.ctx.bus.publish(`run:${run.id}`, ev); }
  if (body.status) s.agents.setStatus(run.id, body.status);
  return c.json({ runId: run.id }, 202);
});
