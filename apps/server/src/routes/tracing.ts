import { Hono } from "hono";
import { z } from "zod";
import { Span, Trace } from "@crucible/core";
import type { Env } from "../context.js";

export const tracing = new Hono<Env>();

tracing.get("/projects/:p/traces", (c) => {
  const q = c.req.query();
  return c.json(c.var.ctx.store.tracing.listTraces({
    projectId: c.var.projectId, status: q.status as never, sessionId: q.sessionId, userId: q.userId, tag: q.tag, search: q.search,
    since: q.since ? Number(q.since) : undefined, until: q.until ? Number(q.until) : undefined, limit: q.limit ? Number(q.limit) : 50, offset: q.offset ? Number(q.offset) : 0,
  }));
});
tracing.get("/projects/:p/stats", (c) => {
  const windowMs = Number(c.req.query("windowMs") ?? 24 * 3600_000);
  return c.json(c.var.ctx.store.tracing.stats(c.var.projectId, windowMs));
});
tracing.get("/traces/:id", (c) => {
  const t = c.var.ctx.store.tracing.getTrace(c.req.param("id"));
  if (!t) return c.json({ error: "not found" }, 404);
  return c.json({ ...t, spans: c.var.ctx.store.tracing.listSpans(t.id) });
});
tracing.delete("/traces/:id", (c) => { c.var.ctx.store.tracing.deleteTrace(c.req.param("id")); return c.body(null, 204); });

/** Batch ingest from the SDK. Traces are upserted; spans are inserted/replaced. */
tracing.post("/ingest", async (c) => {
  const body = z.object({ traces: z.array(Trace.partial().extend({ id: z.string(), name: z.string() })).default([]), spans: z.array(Span).default([]) }).parse(await c.req.json());
  const tr = c.var.ctx.store.tracing;
  const store = c.var.ctx.store;
  let traces = 0, spans = 0;
  store.db.transaction(() => {
    for (const t of body.traces) {
      const projectId = resolveProject(c.var.ctx.store, t.projectId) ?? c.var.projectId;
      if (!tr.getTrace(t.id)) tr.startTrace({ ...t, projectId, name: t.name, metadata: t.metadata ?? {}, tags: t.tags ?? [] });
      if (t.endedAt) tr.endTrace(t.id, { status: t.status === "error" ? "error" : "ok", output: t.output, metadata: t.metadata, endedAt: t.endedAt });
      traces++;
    }
    for (const s of body.spans) {
      if (!tr.getTrace(s.traceId)) tr.startTrace({ id: s.traceId, projectId: c.var.projectId, name: s.name });
      tr.recordSpan(s);
      spans++;
    }
  });
  c.var.ctx.bus.publish(`traces:${c.var.projectId}`, { traces, spans });
  return c.json({ ok: true, traces, spans });
});

function resolveProject(store: Env["Variables"]["ctx"]["store"], idOrSlug?: string): string | undefined {
  if (!idOrSlug) return undefined;
  return store.workbench.getProject(idOrSlug)?.id ?? store.workbench.createProject(idOrSlug).id;
}
