import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { Store } from "@crucible/core";
import { Gateway, MemoryCache, Router, RouterConfig, providersFromEnv, type Provider } from "@crucible/gateway";
import { AgentRuntime } from "@crucible/agents";
import { RagPipeline } from "@crucible/rag";
import { Bus } from "./bus.js";
import { AgentRegistry, demoAgents, loadUserAgents } from "./agents-registry.js";
import type { AppContext, Env } from "./context.js";
import { workbench } from "./routes/workbench.js";
import { tracing, otlp } from "./routes/tracing.js";
import { evals } from "./routes/evals.js";
import { agents } from "./routes/agents.js";
import { gatewayApi, compat } from "./routes/gateway.js";
import { rag } from "./routes/rag.js";
import { ops } from "./routes/ops.js";

export interface CreateAppOptions {
  store?: Store;
  providers?: Provider[];
  adminToken?: string;
  quiet?: boolean;
  registerDemoAgents?: boolean;
  defaultModel?: string;
  /** Load `crucible.agents.mjs` (or $CRUCIBLE_AGENTS) from the working directory. */
  loadUserAgents?: boolean;
}

export function createContext(opts: CreateAppOptions = {}): AppContext {
  const store = opts.store ?? new Store();
  const providers = opts.providers ?? providersFromEnv();
  const savedRoutes = store.ops.kvGet<RouterConfig | null>("gateway.routes", null);
  const router = new Router(providers, savedRoutes ? RouterConfig.parse(savedRoutes) : defaultRoutes(providers));
  const gateway = new Gateway({ providers, router, store, cache: new MemoryCache(), defaultCacheTtlSeconds: Number(process.env.CRUCIBLE_CACHE_TTL ?? 0), rateLimitPerMinute: process.env.CRUCIBLE_RATE_LIMIT ? Number(process.env.CRUCIBLE_RATE_LIMIT) : undefined, redactByDefault: process.env.CRUCIBLE_REDACT === "1" });
  const runtime = new AgentRuntime(store, gateway);
  const ragPipeline = new RagPipeline(store, gateway);
  const registry = new AgentRegistry();
  if (opts.registerDemoAgents ?? true) for (const d of demoAgents(store, ragPipeline, opts.defaultModel ?? (providers.some((p) => p.name === "anthropic") ? "claude-haiku-5-5" : "mock-smart"))) registry.register(d);
  store.workbench.ensureDefaultProject();
  const ctx: AppContext = { store, gateway, runtime, rag: ragPipeline, bus: new Bus(), agents: registry, adminToken: opts.adminToken ?? process.env.CRUCIBLE_ADMIN_TOKEN, jobs: new Map() };
  if (opts.loadUserAgents ?? true) void loadUserAgents(ctx).then((n) => { if (n) console.log(`  loaded ${n} user agent(s) from ${process.env.CRUCIBLE_AGENTS ?? "crucible.agents.mjs"}`); }).catch((err: Error) => console.error("failed to load user agents:", err.message));
  return ctx;
}

function defaultRoutes(providers: Provider[]): RouterConfig {
  const has = (n: string) => providers.some((p) => p.name === n);
  const smart = [has("anthropic") && { provider: "anthropic", model: "claude-sonnet-5-5" }, has("openai") && { provider: "openai", model: "gpt-4.1" }, { provider: "mock", model: "mock-smart" }].filter(Boolean) as Array<{ provider: string; model: string }>;
  const fast = [has("anthropic") && { provider: "anthropic", model: "claude-haiku-5-5" }, has("openai") && { provider: "openai", model: "gpt-4.1-mini" }, { provider: "mock", model: "mock-fast" }].filter(Boolean) as Array<{ provider: string; model: string }>;
  return { routes: [{ name: "smart", strategy: "fallback", targets: smart }, { name: "fast", strategy: "fallback", targets: fast, cacheTtlSeconds: 300 }], defaultRoute: "smart" };
}

export function createApp(ctx: AppContext, opts: { quiet?: boolean } = {}) {
  const app = new Hono<Env>();
  if (!opts.quiet) app.use(logger());
  app.use("*", cors());
  app.onError((err, c) => {
    if (err.name === "ZodError") return c.json({ error: { message: "invalid request", type: "validation", issues: (err as unknown as { issues: unknown[] }).issues } }, 400);
    console.error(err);
    return c.json({ error: { message: err.message, type: "internal" } }, 500);
  });

  // Auth. Trusted local mode when no admin token is configured.
  app.use("*", async (c, next) => {
    c.set("ctx", ctx);
    const auth = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? c.req.header("x-api-key") ?? "";
    let projectId: string | undefined;
    let apiKeyId: string | null = null;
    let actor = "local";
    if (auth.startsWith("cru_")) {
      const key = ctx.store.gateway.verifyKey(auth);
      if (!key) return c.json({ error: { message: "invalid API key", type: "unauthorized" } }, 401);
      projectId = key.projectId; apiKeyId = key.id; actor = `key:${key.name}`;
    } else if (ctx.adminToken) {
      if (auth !== ctx.adminToken && !c.req.path.startsWith("/api/health")) return c.json({ error: { message: "unauthorized", type: "unauthorized" } }, 401);
      actor = "admin";
    }
    const headerProject = c.req.header("x-crucible-project");
    if (headerProject && !apiKeyId) {
      const p = ctx.store.workbench.getProject(headerProject);
      if (!p) return c.json({ error: { message: `project not found: ${headerProject}`, type: "not_found" } }, 404);
      projectId = p.id;
    }
    c.set("projectId", projectId ?? ctx.store.workbench.ensureDefaultProject().id);
    c.set("apiKeyId", apiKeyId);
    c.set("actor", c.req.header("x-crucible-actor") ?? actor);
    await next();
  });

  // Project resolution for /api/projects/:p/* — API keys may only touch their own project.
  app.use("/api/projects/:p/*", async (c, next) => {
    const ref = c.req.param("p");
    const p = ctx.store.workbench.getProject(ref);
    if (!p) return c.json({ error: { message: `project not found: ${ref}`, type: "not_found" } }, 404);
    if (c.var.apiKeyId && c.var.projectId !== p.id) return c.json({ error: { message: "API key does not belong to this project", type: "forbidden" } }, 403);
    c.set("projectId", p.id);
    await next();
  });

  app.get("/api/health", (c) => c.json({ ok: true, version: "0.1.0", providers: ctx.gateway.router.listProviders().map((p) => p.name), trusted: !ctx.adminToken }));
  app.route("/api", workbench);
  app.route("/api", tracing);
  app.route("/api", evals);
  app.route("/api", agents);
  app.route("/api", gatewayApi);
  app.route("/api", rag);
  app.route("/api", ops);
  app.route("/v1", compat);
  app.route("/v1", otlp);
  return app;
}
