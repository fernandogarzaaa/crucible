import { estimateCost, type ChatRequest, type ChatResponse, type Store, type Usage } from "@crucible/core";
import { MemoryCache, requestKey, type CacheStore } from "./cache.js";
import { RateLimiter } from "./ratelimit.js";
import { DEFAULT_RULES, redactRequest, type RedactionRule } from "./redact.js";
import { Router, type ResolvedTarget } from "./router.js";
import { ProviderError, type Provider, type StreamEvent } from "./types.js";

export interface GatewayOptions {
  providers: Provider[];
  store?: Store;
  router?: Router;
  cache?: CacheStore;
  /** Default TTL for cached responses when a route does not specify one. 0 disables caching. */
  defaultCacheTtlSeconds?: number;
  redactionRules?: RedactionRule[];
  /** Default redaction when a route does not specify. */
  redactByDefault?: boolean;
  rateLimitPerMinute?: number;
  /** Max retries per target on retryable errors (in addition to fallback across targets). */
  retriesPerTarget?: number;
  clock?: () => number;
}

export interface CallContext {
  projectId: string;
  apiKeyId?: string | null;
  /** Budget scopes to check, e.g. ["project", "key:<id>", "agent:researcher"]. */
  scopes?: string[];
  traceId?: string | null;
  /** Rate-limit bucket key (defaults to apiKeyId or projectId). */
  limiterKey?: string;
  signal?: AbortSignal;
}

export class GatewayError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); this.name = "GatewayError"; }
}

/**
 * The gateway is the one door every model call walks through: budgets, rate limits, redaction,
 * caching, routing with fallback, cost accounting and an audit row per request.
 */
export class Gateway {
  readonly router: Router;
  readonly cache: CacheStore;
  private readonly store?: Store;
  private readonly limiter?: RateLimiter;
  private readonly opts: Required<Pick<GatewayOptions, "defaultCacheTtlSeconds" | "redactByDefault" | "retriesPerTarget">> & { redactionRules: RedactionRule[] };
  private readonly now: () => number;

  constructor(options: GatewayOptions) {
    this.router = options.router ?? new Router(options.providers);
    this.cache = options.cache ?? new MemoryCache();
    this.store = options.store;
    this.limiter = options.rateLimitPerMinute ? new RateLimiter(options.rateLimitPerMinute) : undefined;
    this.opts = {
      defaultCacheTtlSeconds: options.defaultCacheTtlSeconds ?? 0,
      redactByDefault: options.redactByDefault ?? false,
      retriesPerTarget: options.retriesPerTarget ?? 1,
      redactionRules: options.redactionRules ?? DEFAULT_RULES,
    };
    this.now = options.clock ?? Date.now;
  }

  private preflight(req: ChatRequest, ctx: CallContext): { attempts: ResolvedTarget[]; req: ChatRequest; cacheTtl: number; routeName: string } {
    if (this.limiter) {
      const key = ctx.limiterKey ?? ctx.apiKeyId ?? ctx.projectId;
      if (!this.limiter.take(key)) throw new GatewayError(`rate limit exceeded; retry in ${this.limiter.retryAfterMs(key)}ms`, 429, "rate_limited");
    }
    if (this.store) {
      const scopes = ctx.scopes ?? ["project", ...(ctx.apiKeyId ? [`key:${ctx.apiKeyId}`] : [])];
      const exceeded = this.store.gateway.checkBudgets(ctx.projectId, scopes);
      if (exceeded) throw new GatewayError(`budget exceeded for ${exceeded.scope} (${exceeded.period}): $${exceeded.spentUsd.toFixed(4)} of $${exceeded.limitUsd}`, 402, "budget_exceeded");
    }
    const { attempts, route } = this.router.resolve(req.config.model);
    const redact = route?.redact ?? this.opts.redactByDefault;
    const effective = redact ? redactRequest(req, this.opts.redactionRules).request : req;
    const cacheTtl = route?.cacheTtlSeconds ?? this.opts.defaultCacheTtlSeconds;
    return { attempts, req: effective, cacheTtl, routeName: route?.name ?? "direct" };
  }

  async chat(req: ChatRequest, ctx: CallContext): Promise<ChatResponse> {
    const start = this.now();
    const { attempts, req: effective, cacheTtl, routeName } = this.preflight(req, ctx);
    const key = cacheTtl > 0 ? requestKey(effective) : null;
    if (key) {
      const hit = this.cache.get(key);
      if (hit) {
        const resp: ChatResponse = { ...hit, cached: true, latencyMs: this.now() - start, costUsd: 0 };
        this.record(ctx, req.config.model, resp.model, resp.provider, routeName, 200, true, 0, resp.latencyMs, resp.usage, 0, null);
        return resp;
      }
    }
    let lastErr: unknown;
    let depth = 0;
    for (const target of attempts) {
      for (let retry = 0; retry <= this.opts.retriesPerTarget; retry++) {
        const t0 = this.now();
        try {
          const raw = await target.provider.chat({ ...effective, config: { ...effective.config, model: target.model, provider: target.provider.name } }, ctx.signal);
          const costUsd = estimateCost(raw.model, raw.usage);
          const resp: ChatResponse = { ...raw, costUsd, cached: false, latencyMs: this.now() - start };
          if (key) this.cache.set(key, resp, cacheTtl * 1000);
          this.record(ctx, req.config.model, raw.model, target.provider.name, routeName, 200, false, depth, this.now() - t0, raw.usage, costUsd, null);
          return resp;
        } catch (err) {
          lastErr = err;
          const pe = err instanceof ProviderError ? err : undefined;
          this.record(ctx, req.config.model, target.model, target.provider.name, routeName, pe?.status ?? 500, false, depth, this.now() - t0, { inputTokens: 0, outputTokens: 0 }, 0, String((err as Error).message ?? err));
          if (ctx.signal?.aborted) throw err;
          if (pe && !pe.retryable) break; // non-retryable on this target: move to the next target
        }
      }
      depth++;
    }
    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    throw new GatewayError(`all ${attempts.length} target(s) failed: ${msg}`, lastErr instanceof ProviderError ? lastErr.status : 502, "upstream_failed");
  }

  /**
   * Streaming with fallback: if a target fails before emitting any content, the next target is tried.
   * Once content has started flowing, errors are surfaced to the client.
   */
  async *stream(req: ChatRequest, ctx: CallContext): AsyncIterable<StreamEvent> {
    const start = this.now();
    const { attempts, req: effective, routeName } = this.preflight(req, ctx);
    let depth = 0;
    let lastErr: unknown;
    for (const target of attempts) {
      const t0 = this.now();
      let emitted = false;
      let usage: Usage = { inputTokens: 0, outputTokens: 0 };
      try {
        for await (const ev of target.provider.stream({ ...effective, stream: true, config: { ...effective.config, model: target.model, provider: target.provider.name } }, ctx.signal)) {
          if (ev.type === "text_delta" || ev.type === "tool_use_start") emitted = true;
          if (ev.type === "end") {
            usage = ev.usage;
            const costUsd = estimateCost(target.model, usage);
            this.record(ctx, req.config.model, target.model, target.provider.name, routeName, 200, false, depth, this.now() - t0, usage, costUsd, null);
            yield { ...ev };
            yield { type: "usage", usage: { ...usage } };
            return;
          }
          if (ev.type === "error") throw new ProviderError(ev.error, target.provider.name, 502, !emitted);
          yield ev;
        }
        return;
      } catch (err) {
        lastErr = err;
        const pe = err instanceof ProviderError ? err : undefined;
        this.record(ctx, req.config.model, target.model, target.provider.name, routeName, pe?.status ?? 500, false, depth, this.now() - t0, usage, 0, String((err as Error).message ?? err));
        if (emitted || ctx.signal?.aborted) { yield { type: "error", error: (err as Error).message }; return; }
        depth++;
      }
    }
    void start;
    yield { type: "error", error: `all ${attempts.length} target(s) failed: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}` };
  }

  async embed(model: string, inputs: string[], ctx: CallContext): Promise<{ embeddings: number[][]; usage: Usage; costUsd: number; model: string; provider: string }> {
    const { attempts } = this.router.resolve(model);
    let lastErr: unknown;
    for (const t of attempts) {
      if (!t.provider.embed) continue;
      const t0 = this.now();
      try {
        const out = await t.provider.embed(t.model, inputs, ctx.signal);
        const costUsd = estimateCost(t.model, out.usage);
        this.record(ctx, model, t.model, t.provider.name, "embed", 200, false, 0, this.now() - t0, out.usage, costUsd, null);
        return { ...out, costUsd, model: t.model, provider: t.provider.name };
      } catch (err) { lastErr = err; }
    }
    throw new GatewayError(`no embedding provider for "${model}": ${lastErr instanceof Error ? lastErr.message : "none configured"}`, 502, "upstream_failed");
  }

  private record(ctx: CallContext, requested: string, served: string, provider: string, route: string, status: number, cached: boolean, depth: number, latencyMs: number, usage: Usage, costUsd: number, error: string | null) {
    this.store?.gateway.record({
      projectId: ctx.projectId, apiKeyId: ctx.apiKeyId ?? null, requestedModel: requested, servedModel: served, provider, route, status, cached,
      fallbackDepth: depth, latencyMs, usage, costUsd, traceId: ctx.traceId ?? null, error,
    });
  }
}
