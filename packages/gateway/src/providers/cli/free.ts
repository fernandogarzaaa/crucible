import type { Route } from "../../router.js";
import { capture, stripAnsi, which } from "./run.js";

export interface FreeModelCatalog {
  /** OpenCode Zen free models, as OpenCode model ids (e.g. "opencode/glm-5.3-flash-free"). */
  opencodeZen: string[];
  /** OpenRouter models whose id ends in ":free" (e.g. "google/gemma-4-31b-it:free"). */
  openrouter: string[];
  discoveredAt: number;
  errors: string[];
}

/** List OpenCode's built-in Zen models and keep the zero-cost ones (ids ending in "-free"). */
export async function discoverOpenCodeFree(bin = "opencode"): Promise<string[]> {
  if (!which(bin)) return [];
  const r = await capture(bin, ["models", "opencode"], { timeoutMs: 60_000 });
  return stripAnsi(r.stdout).split("\n").map((l) => l.trim()).filter((l) => /^opencode\/\S+-free$/.test(l));
}

/** OpenRouter publishes its catalogue without a key; free variants carry a ":free" suffix. */
export async function discoverOpenRouterFree(f: typeof fetch = fetch): Promise<string[]> {
  const res = await f("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`openrouter models: HTTP ${res.status}`);
  const data = (await res.json()) as { data?: Array<{ id: string; context_length?: number }> };
  return (data.data ?? []).filter((m) => m.id.endsWith(":free")).sort((a, b) => (b.context_length ?? 0) - (a.context_length ?? 0)).map((m) => m.id);
}

export async function discoverFreeModels(opts: { opencodeBin?: string; fetch?: typeof fetch } = {}): Promise<FreeModelCatalog> {
  const errors: string[] = [];
  const [oc, or] = await Promise.all([
    discoverOpenCodeFree(opts.opencodeBin).catch((e: Error) => { errors.push(`opencode: ${e.message}`); return [] as string[]; }),
    discoverOpenRouterFree(opts.fetch).catch((e: Error) => { errors.push(`openrouter: ${e.message}`); return [] as string[]; }),
  ]);
  return { opencodeZen: oc, openrouter: or, discoveredAt: Date.now(), errors };
}

/**
 * Build the `free` route: OpenCode Zen free models first (no account needed), then OpenRouter free
 * models through OpenCode and Cline when an OpenRouter key is available. Fallback order means a
 * rate-limited free model hands the request to the next one.
 */
export function buildFreeRoute(catalog: FreeModelCatalog, have: { opencode: boolean; cline: boolean; openrouterKey: boolean }, perSource = 4): Route | null {
  const targets: Route["targets"] = [];
  if (have.opencode) for (const m of catalog.opencodeZen.slice(0, perSource)) targets.push({ provider: "opencode", model: m });
  if (have.openrouterKey) {
    const or = catalog.openrouter.slice(0, perSource);
    if (have.opencode) for (const m of or.slice(0, 2)) targets.push({ provider: "opencode", model: `openrouter/${m}` });
    if (have.cline) for (const m of or.slice(0, perSource)) targets.push({ provider: "cline", model: `openrouter/${m}` });
  }
  if (!targets.length) return null;
  return { name: "free", strategy: "fallback", targets };
}
