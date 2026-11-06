import { Hono } from "hono";
import { z } from "zod";
import { Message, ModelConfig } from "@crucible/core";
import type { Env } from "../context.js";

export const workbench = new Hono<Env>();

workbench.get("/projects", (c) => c.json(c.var.ctx.store.workbench.listProjects()));
workbench.post("/projects", async (c) => {
  const { name } = z.object({ name: z.string().min(1) }).parse(await c.req.json());
  const p = c.var.ctx.store.workbench.createProject(name);
  c.var.ctx.store.ops.audit({ projectId: p.id, actor: c.var.actor, action: "project.create", targetType: "project", targetId: p.id });
  return c.json(p, 201);
});

// Prompts
workbench.get("/projects/:p/prompts", (c) => c.json(c.var.ctx.store.workbench.listPrompts(c.var.projectId)));
workbench.post("/projects/:p/prompts", async (c) => {
  const body = z.object({ name: z.string().min(1), description: z.string().optional(), template: z.array(Message).optional(), config: ModelConfig.optional(), labels: z.array(z.string()).optional() }).parse(await c.req.json());
  const wb = c.var.ctx.store.workbench;
  const prompt = wb.getPrompt(c.var.projectId, body.name) ?? wb.createPrompt(c.var.projectId, body.name, body.description);
  const version = body.template && body.config ? wb.createVersion(prompt.id, { template: body.template, config: body.config, labels: body.labels }) : undefined;
  return c.json({ prompt, version }, 201);
});
workbench.get("/projects/:p/prompts/resolve", (c) => {
  const ref = c.req.query("ref");
  if (!ref) return c.json({ error: "ref required" }, 400);
  const v = c.var.ctx.store.workbench.resolveVersion(c.var.projectId, ref);
  return v ? c.json(v) : c.json({ error: "not found" }, 404);
});
workbench.get("/projects/:p/prompts/:id", (c) => {
  const wb = c.var.ctx.store.workbench;
  const prompt = wb.getPrompt(c.var.projectId, c.req.param("id"));
  if (!prompt) return c.json({ error: "not found" }, 404);
  return c.json({ ...prompt, versions: wb.listVersions(prompt.id) });
});
workbench.post("/projects/:p/prompts/:id/versions", async (c) => {
  const wb = c.var.ctx.store.workbench;
  const prompt = wb.getPrompt(c.var.projectId, c.req.param("id"));
  if (!prompt) return c.json({ error: "not found" }, 404);
  const body = z.object({ template: z.array(Message), config: ModelConfig, commitMessage: z.string().optional(), labels: z.array(z.string()).optional() }).parse(await c.req.json());
  const v = wb.createVersion(prompt.id, body);
  c.var.ctx.store.ops.audit({ projectId: c.var.projectId, actor: c.var.actor, action: "prompt.version.create", targetType: "prompt_version", targetId: v.id, details: { prompt: prompt.name, version: v.version } });
  return c.json(v, 201);
});
workbench.post("/prompt-versions/:id/labels", async (c) => {
  const { label } = z.object({ label: z.string().min(1) }).parse(await c.req.json());
  const v = c.var.ctx.store.workbench.setLabel(c.req.param("id"), label);
  if (!v) return c.json({ error: "not found" }, 404);
  c.var.ctx.store.ops.audit({ projectId: c.var.projectId, actor: c.var.actor, action: "prompt.label.set", targetType: "prompt_version", targetId: v.id, details: { label } });
  return c.json(v);
});

// Datasets
workbench.get("/projects/:p/datasets", (c) => c.json(c.var.ctx.store.workbench.listDatasets(c.var.projectId)));
workbench.post("/projects/:p/datasets", async (c) => {
  const body = z.object({ name: z.string().min(1), description: z.string().optional(), items: z.array(z.object({ input: z.record(z.any()), expected: z.any().optional(), metadata: z.record(z.any()).optional() })).optional() }).parse(await c.req.json());
  const wb = c.var.ctx.store.workbench;
  const ds = wb.getDataset(c.var.projectId, body.name) ?? wb.createDataset(c.var.projectId, body.name, body.description);
  if (body.items?.length) wb.addItems(ds.id, body.items);
  return c.json({ ...ds, itemCount: wb.listItems(ds.id).length }, 201);
});
workbench.get("/datasets/:id/items", (c) => c.json(c.var.ctx.store.workbench.listItems(c.req.param("id"))));
workbench.post("/datasets/:id/items", async (c) => {
  const items = z.array(z.object({ input: z.record(z.any()), expected: z.any().optional(), metadata: z.record(z.any()).optional() })).parse(await c.req.json());
  return c.json(c.var.ctx.store.workbench.addItems(c.req.param("id"), items), 201);
});
workbench.delete("/dataset-items/:id", (c) => { c.var.ctx.store.workbench.deleteItem(c.req.param("id")); return c.body(null, 204); });
