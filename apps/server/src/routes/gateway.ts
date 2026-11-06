import { Hono } from "hono";
import { stream } from "hono/streaming";
import { z } from "zod";
import { ChatRequest, listPricing } from "@crucible/core";
import { GatewayError, RouterConfig } from "@crucible/gateway";
import type { Env } from "../context.js";
import { fromAnthropicRequest, fromOpenAIRequest, toAnthropicEvents, toAnthropicResponse, toOpenAIChunks, toOpenAIResponse } from "../compat.js";

export const gatewayApi = new Hono<Env>();
export const compat = new Hono<Env>();

const errBody = (err: unknown) => {
  if (err instanceof GatewayError) return { status: err.status, body: { error: { message: err.message, type: err.code, code: err.code } } };
  return { status: 500, body: { error: { message: (err as Error).message ?? String(err), type: "internal" } } };
};

// ---- native API
gatewayApi.post("/projects/:p/chat", async (c) => {
  const req = ChatRequest.parse(await c.req.json());
  const ctx = { projectId: c.var.projectId, apiKeyId: c.var.apiKeyId, signal: c.req.raw.signal };
  try {
    if (!req.stream) return c.json(await c.var.ctx.gateway.chat(req, ctx));
    c.header("content-type", "text/event-stream"); c.header("cache-control", "no-cache");
    return stream(c, async (s) => { for await (const ev of c.var.ctx.gateway.stream(req, ctx)) await s.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`); });
  } catch (err) { const e = errBody(err); return c.json(e.body, e.status as 400); }
});
gatewayApi.post("/projects/:p/embed", async (c) => {
  const body = z.object({ model: z.string(), input: z.array(z.string()).min(1) }).parse(await c.req.json());
  try { return c.json(await c.var.ctx.gateway.embed(body.model, body.input, { projectId: c.var.projectId, apiKeyId: c.var.apiKeyId })); }
  catch (err) { const e = errBody(err); return c.json(e.body, e.status as 400); }
});
gatewayApi.get("/gateway/models", (c) => {
  const router = c.var.ctx.gateway.router;
  const providers = router.listProviders().map((p) => ({ provider: p.name, models: p.models() }));
  return c.json({ providers, routes: router.getConfig().routes, pricing: listPricing() });
});
gatewayApi.get("/gateway/routes", (c) => c.json(c.var.ctx.gateway.router.getConfig()));
gatewayApi.put("/gateway/routes", async (c) => {
  const cfg = RouterConfig.parse(await c.req.json());
  c.var.ctx.gateway.router.setConfig(cfg);
  c.var.ctx.store.ops.kvSet("gateway.routes", cfg);
  c.var.ctx.store.ops.audit({ actor: c.var.actor, action: "gateway.routes.update", targetType: "router", targetId: "routes", details: { routes: cfg.routes.map((r) => r.name) } });
  return c.json(cfg);
});
gatewayApi.get("/projects/:p/gateway/requests", (c) => c.json(c.var.ctx.store.gateway.list(c.var.projectId, Number(c.req.query("limit") ?? 100))));
gatewayApi.get("/projects/:p/gateway/stats", (c) => c.json(c.var.ctx.store.gateway.stats(c.var.projectId, Number(c.req.query("windowMs") ?? 24 * 3600_000))));

// Budgets
gatewayApi.get("/projects/:p/budgets", (c) => c.json(c.var.ctx.store.gateway.listBudgets(c.var.projectId)));
gatewayApi.post("/projects/:p/budgets", async (c) => {
  const body = z.object({ scope: z.string().default("project"), limitUsd: z.number().positive(), period: z.enum(["daily", "weekly", "monthly", "total"]).default("monthly"), hardStop: z.boolean().default(true) }).parse(await c.req.json());
  const b = c.var.ctx.store.gateway.setBudget({ projectId: c.var.projectId, ...body });
  c.var.ctx.store.ops.audit({ projectId: c.var.projectId, actor: c.var.actor, action: "budget.set", targetType: "budget", targetId: b.id, details: body });
  return c.json(b, 201);
});
gatewayApi.delete("/budgets/:id", (c) => { c.var.ctx.store.gateway.deleteBudget(c.req.param("id")); return c.body(null, 204); });

// API keys
gatewayApi.get("/projects/:p/keys", (c) => c.json(c.var.ctx.store.gateway.listKeys(c.var.projectId).map(({ hash: _h, ...k }) => k)));
gatewayApi.post("/projects/:p/keys", async (c) => {
  const body = z.object({ name: z.string().min(1), scopes: z.array(z.string()).default(["gateway"]) }).parse(await c.req.json());
  const { key, secret } = c.var.ctx.store.gateway.createKey(c.var.projectId, body.name, body.scopes);
  c.var.ctx.store.ops.audit({ projectId: c.var.projectId, actor: c.var.actor, action: "apikey.create", targetType: "api_key", targetId: key.id, details: { name: body.name } });
  const { hash: _h, ...safe } = key;
  return c.json({ ...safe, secret }, 201);
});
gatewayApi.delete("/keys/:id", (c) => {
  c.var.ctx.store.gateway.revokeKey(c.req.param("id"));
  c.var.ctx.store.ops.audit({ projectId: c.var.projectId, actor: c.var.actor, action: "apikey.revoke", targetType: "api_key", targetId: c.req.param("id") });
  return c.body(null, 204);
});

// ---- OpenAI-compatible: POST /v1/chat/completions, GET /v1/models, POST /v1/embeddings
compat.get("/models", (c) => {
  const router = c.var.ctx.gateway.router;
  const data = [...router.getConfig().routes.map((r) => ({ id: r.name, object: "model", owned_by: "crucible-route" })), ...router.listProviders().flatMap((p) => p.models().map((m) => ({ id: m, object: "model", owned_by: p.name })))];
  return c.json({ object: "list", data });
});
compat.post("/chat/completions", async (c) => {
  const body = await c.req.json();
  const req = fromOpenAIRequest(body);
  const ctx = { projectId: c.var.projectId, apiKeyId: c.var.apiKeyId, signal: c.req.raw.signal };
  try {
    if (!req.stream) return c.json(toOpenAIResponse(await c.var.ctx.gateway.chat(req, ctx)));
    c.header("content-type", "text/event-stream"); c.header("cache-control", "no-cache");
    const id = `chatcmpl_${Date.now()}`;
    return stream(c, async (s) => { for await (const ev of c.var.ctx.gateway.stream(req, ctx)) for (const frame of toOpenAIChunks(ev, id, req.config.model)) await s.write(frame); });
  } catch (err) { const e = errBody(err); return c.json(e.body, e.status as 400); }
});
compat.post("/embeddings", async (c) => {
  const body = z.object({ model: z.string(), input: z.union([z.string(), z.array(z.string())]) }).parse(await c.req.json());
  const inputs = typeof body.input === "string" ? [body.input] : body.input;
  try {
    const r = await c.var.ctx.gateway.embed(body.model, inputs, { projectId: c.var.projectId, apiKeyId: c.var.apiKeyId });
    return c.json({ object: "list", model: r.model, data: r.embeddings.map((e, i) => ({ object: "embedding", index: i, embedding: e })), usage: { prompt_tokens: r.usage.inputTokens, total_tokens: r.usage.inputTokens } });
  } catch (err) { const e = errBody(err); return c.json(e.body, e.status as 400); }
});

// ---- Anthropic-compatible: POST /v1/messages
compat.post("/messages", async (c) => {
  const req = fromAnthropicRequest(await c.req.json());
  const ctx = { projectId: c.var.projectId, apiKeyId: c.var.apiKeyId, signal: c.req.raw.signal };
  try {
    if (!req.stream) return c.json(toAnthropicResponse(await c.var.ctx.gateway.chat(req, ctx)));
    c.header("content-type", "text/event-stream"); c.header("cache-control", "no-cache");
    const id = `msg_${Date.now()}`;
    const state = { index: 0, textOpen: false };
    return stream(c, async (s) => { for await (const ev of c.var.ctx.gateway.stream(req, ctx)) for (const frame of toAnthropicEvents(ev, id, req.config.model, state)) await s.write(frame); });
  } catch (err) { const e = errBody(err); return c.json({ type: "error", error: { type: e.body.error.type, message: e.body.error.message } }, e.status as 400); }
});
