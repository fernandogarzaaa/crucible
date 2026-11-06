#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp, createContext } from "./app.js";

export { createApp, createContext } from "./app.js";
export { refreshFreeModels } from "./free-models.js";
export type { AppContext } from "./context.js";
export { AgentRegistry } from "./agents-registry.js";

export function startServer(opts: { port?: number; host?: string; webDir?: string } = {}) {
  const ctx = createContext();
  const app = createApp(ctx);
  const here = dirname(fileURLToPath(import.meta.url));
  const webDir = opts.webDir ?? [resolve(here, "../../web/dist"), resolve(here, "../../../apps/web/dist"), resolve(process.cwd(), "apps/web/dist")].find((d) => existsSync(join(d, "index.html")));
  if (webDir) {
    const rel = webDir.startsWith(process.cwd()) ? webDir.slice(process.cwd().length + 1) || "." : webDir;
    app.use("/assets/*", serveStatic({ root: rel }));
    app.get("*", serveStatic({ root: rel, rewriteRequestPath: () => "/index.html" }));
  }
  const port = opts.port ?? Number(process.env.CRUCIBLE_PORT ?? 4800);
  const host = opts.host ?? process.env.CRUCIBLE_HOST ?? "127.0.0.1";
  const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
    console.log(`\n  Crucible ready at http://${host}:${info.port}`);
    console.log(`  API:      http://${host}:${info.port}/api/health`);
    console.log(`  Gateway:  http://${host}:${info.port}/v1/chat/completions  (OpenAI-compatible)   /v1/messages (Anthropic-compatible)`);
    console.log(`  Data:     ${ctx.store.home}`);
    console.log(`  Providers: ${ctx.gateway.router.listProviders().map((p) => p.name).join(", ")}${ctx.adminToken ? "" : "   [trusted local mode: no auth]"}\n`);
  });
  return { server, ctx, app };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) startServer();
