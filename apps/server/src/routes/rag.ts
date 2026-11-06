import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../context.js";

export const rag = new Hono<Env>();

rag.get("/projects/:p/kbs", (c) => c.json(c.var.ctx.store.rag.listKbs(c.var.projectId)));
rag.post("/projects/:p/kbs", async (c) => {
  const body = z.object({ name: z.string().min(1), embeddingModel: z.string().optional(), chunkSize: z.number().int().positive().optional(), chunkOverlap: z.number().int().nonnegative().optional() }).parse(await c.req.json());
  const existing = c.var.ctx.store.rag.getKb(c.var.projectId, body.name);
  return c.json(existing ?? c.var.ctx.store.rag.createKb({ projectId: c.var.projectId, ...body }), existing ? 200 : 201);
});
rag.get("/kbs/:id", (c) => {
  const kb = c.var.ctx.store.rag.getKbById(c.req.param("id"));
  if (!kb) return c.json({ error: "not found" }, 404);
  return c.json({ ...kb, documents: c.var.ctx.store.rag.listDocuments(kb.id) });
});
rag.delete("/kbs/:id", (c) => { c.var.ctx.store.rag.deleteKb(c.req.param("id")); return c.body(null, 204); });

rag.post("/kbs/:id/documents", async (c) => {
  const kb = c.var.ctx.store.rag.getKbById(c.req.param("id"));
  if (!kb) return c.json({ error: "not found" }, 404);
  const docs = z.array(z.object({ source: z.string(), title: z.string().optional(), content: z.string(), metadata: z.record(z.any()).optional() })).parse(await c.req.json());
  const results = [];
  for (const d of docs) results.push({ source: d.source, ...(await c.var.ctx.rag.ingestText(kb, d)) });
  return c.json(results, 201);
});
rag.post("/kbs/:id/ingest-dir", async (c) => {
  const kb = c.var.ctx.store.rag.getKbById(c.req.param("id"));
  if (!kb) return c.json({ error: "not found" }, 404);
  if (c.var.ctx.adminToken === undefined && process.env.CRUCIBLE_ALLOW_FS !== "1" && !c.req.header("host")?.startsWith("localhost") && !c.req.header("host")?.startsWith("127.0.0.1")) return c.json({ error: "filesystem ingestion is only allowed from localhost in trusted mode" }, 403);
  const { dir, extensions } = z.object({ dir: z.string(), extensions: z.array(z.string()).optional() }).parse(await c.req.json());
  return c.json(await c.var.ctx.rag.ingestDirectory(kb, dir, { extensions }));
});
rag.delete("/documents/:id", (c) => { c.var.ctx.store.rag.deleteDocument(c.req.param("id")); return c.body(null, 204); });
rag.get("/documents/:id/chunks", (c) => c.json(c.var.ctx.store.rag.chunksForDocument(c.req.param("id")).map(({ embedding: _e, ...rest }) => rest)));

/** Query inspector: returns the retrieved chunks with per-signal scores. */
rag.post("/kbs/:id/query", async (c) => {
  const kb = c.var.ctx.store.rag.getKbById(c.req.param("id"));
  if (!kb) return c.json({ error: "not found" }, 404);
  const body = z.object({ query: z.string().min(1), k: z.number().int().positive().max(50).optional(), mode: z.enum(["hybrid", "vector", "keyword"]).optional(), rerankModel: z.string().optional(), trace: z.boolean().optional() }).parse(await c.req.json());
  const trace = body.trace ? c.var.ctx.store.tracing.startTrace({ projectId: kb.projectId, name: "rag:query", input: body.query, tags: ["rag"] }) : null;
  const t0 = Date.now();
  const hits = await c.var.ctx.rag.retrieve(kb, body.query, { k: body.k, mode: body.mode, rerankModel: body.rerankModel, traceId: trace?.id ?? null });
  if (trace) c.var.ctx.store.tracing.endTrace(trace.id, { output: hits.map((h) => h.chunk.id) });
  const docs = new Map(c.var.ctx.store.rag.listDocuments(kb.id).map((d) => [d.id, d]));
  return c.json({ latencyMs: Date.now() - t0, traceId: trace?.id ?? null, hits: hits.map((h) => ({ chunkId: h.chunk.id, documentId: h.chunk.documentId, source: docs.get(h.chunk.documentId)?.source ?? null, index: h.chunk.index, text: h.chunk.text, score: h.score, signals: h.signals })) });
});
rag.post("/kbs/:id/evaluate", async (c) => {
  const kb = c.var.ctx.store.rag.getKbById(c.req.param("id"));
  if (!kb) return c.json({ error: "not found" }, 404);
  const body = z.object({ cases: z.array(z.object({ query: z.string(), expectedSources: z.array(z.string()).optional(), expectedText: z.array(z.string()).optional() })).min(1), k: z.number().int().positive().optional(), mode: z.enum(["hybrid", "vector", "keyword"]).optional() }).parse(await c.req.json());
  return c.json(await c.var.ctx.rag.evaluateRetrieval(kb, body.cases, { k: body.k, mode: body.mode }));
});
