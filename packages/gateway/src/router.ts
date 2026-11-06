import { z } from "zod";
import { getPricing } from "@crucible/core";
import type { Provider } from "./types.js";

export const RouteTarget = z.object({ provider: z.string(), model: z.string(), weight: z.number().positive().optional() });
export type RouteTarget = z.infer<typeof RouteTarget>;

export const Route = z.object({
  /** Alias clients send as `model`, e.g. "smart", "fast", "default". */
  name: z.string(),
  strategy: z.enum(["fallback", "round_robin", "cheapest", "weighted"]).default("fallback"),
  targets: z.array(RouteTarget).min(1),
  /** Max total attempts across targets. */
  maxAttempts: z.number().int().positive().optional(),
  cacheTtlSeconds: z.number().int().nonnegative().optional(),
  redact: z.boolean().optional(),
});
export type Route = z.infer<typeof Route>;

export const RouterConfig = z.object({
  routes: z.array(Route).default([]),
  /** Default when the requested model matches no route and no provider claims it. */
  defaultRoute: z.string().optional(),
});
export type RouterConfig = z.infer<typeof RouterConfig>;

export interface ResolvedTarget { provider: Provider; model: string; route: string }

export class Router {
  private rr = new Map<string, number>();
  constructor(
    private providers: Provider[],
    private config: RouterConfig = { routes: [] },
  ) {}

  setConfig(config: RouterConfig) { this.config = RouterConfig.parse(config); }
  getConfig(): RouterConfig { return this.config; }
  listProviders(): Provider[] { return this.providers; }
  addProvider(p: Provider) { this.providers = [...this.providers.filter((x) => x.name !== p.name), p]; }
  provider(name: string): Provider | undefined { return this.providers.find((p) => p.name === name); }

  /**
   * Resolve a requested model id into an ordered list of attempts.
   *  - "provider/model" pins a provider
   *  - a route alias expands according to its strategy
   *  - a bare model id picks the first provider that claims it
   */
  resolve(requested: string): { attempts: ResolvedTarget[]; route?: Route } {
    const named = this.config.routes.find((r) => r.name === requested);
    if (named) return { attempts: this.expand(named), route: named };
    // An explicit `provider/model` pin must never be silently rerouted to the default route.
    if (requested.includes("/")) {
      const [pname] = requested.split("/");
      if (!this.provider(pname!)) throw new Error(`unknown provider "${pname}" in model "${requested}" (configured: ${this.providers.map((p) => p.name).join(", ")})`);
    }
    const route = this.config.defaultRoute && !this.directlyServable(requested) ? this.config.routes.find((r) => r.name === this.config.defaultRoute) : undefined;
    if (route) return { attempts: this.expand(route), route };
    if (requested.includes("/")) {
      const [pname, ...rest] = requested.split("/");
      const p = this.provider(pname!);
      if (!p) throw new Error(`unknown provider: ${pname}`);
      return { attempts: [{ provider: p, model: rest.join("/"), route: "direct" }] };
    }
    const p = this.providers.find((x) => x.supports(requested));
    if (!p) throw new Error(`no provider serves model "${requested}" and no default route is configured`);
    return { attempts: [{ provider: p, model: requested, route: "direct" }] };
  }

  private directlyServable(model: string): boolean {
    if (model.includes("/")) return !!this.provider(model.split("/")[0]!);
    return this.providers.some((p) => p.supports(model));
  }

  private expand(route: Route): ResolvedTarget[] {
    const targets = route.targets
      .map((t) => ({ t, p: this.provider(t.provider) }))
      .filter((x): x is { t: typeof x.t; p: Provider } => !!x.p)
      .map(({ t, p }) => ({ provider: p, model: t.model, route: route.name, weight: t.weight ?? 1 }));
    if (!targets.length) throw new Error(`route "${route.name}" has no configured providers`);
    let ordered = targets;
    switch (route.strategy) {
      case "round_robin": {
        const i = (this.rr.get(route.name) ?? 0) % targets.length;
        this.rr.set(route.name, i + 1);
        ordered = [...targets.slice(i), ...targets.slice(0, i)];
        break;
      }
      case "cheapest":
        ordered = [...targets].sort((a, b) => cost(a.model) - cost(b.model));
        break;
      case "weighted": {
        // Pick a start index proportionally to weight, then fall back through the rest.
        const total = targets.reduce((a, t) => a + t.weight, 0);
        let r = Math.random() * total;
        let i = 0;
        for (; i < targets.length; i++) { r -= targets[i]!.weight; if (r <= 0) break; }
        i = Math.min(i, targets.length - 1);
        ordered = [...targets.slice(i), ...targets.slice(0, i)];
        break;
      }
      case "fallback":
      default:
        break;
    }
    const max = route.maxAttempts ?? ordered.length;
    return ordered.slice(0, max).map(({ provider, model, route: r }) => ({ provider, model, route: r }));
  }
}

const cost = (model: string) => { const p = getPricing(model); return p ? p.input + p.output : Number.MAX_SAFE_INTEGER; };
