import { buildFreeRoute, discoverFreeModels, type FreeModelCatalog } from "@crucible/gateway";
import type { AppContext } from "./context.js";

/** Rediscover free models and, unless the user saved their own `free` route, regenerate it. */
export async function refreshFreeModels(ctx: AppContext): Promise<FreeModelCatalog> {
  const catalog = await discoverFreeModels();
  ctx.freeCatalog = catalog;
  if (ctx.freeRouteAuto) {
    const names = new Set(ctx.gateway.router.listProviders().map((p) => p.name));
    const route = buildFreeRoute(catalog, { opencode: names.has("opencode"), cline: names.has("cline"), openrouterKey: !!process.env.OPENROUTER_API_KEY });
    const cfg = ctx.gateway.router.getConfig();
    const routes = cfg.routes.filter((r) => r.name !== "free");
    if (route) routes.push(route);
    ctx.gateway.router.setConfig({ ...cfg, routes });
  }
  return catalog;
}

