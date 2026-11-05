import type { Usage } from "./schema.js";

/** USD per 1M tokens. Override or extend at runtime via `registerPricing`. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

const PRICES = new Map<string, ModelPrice>([
  // Anthropic (Claude 5 family and recent predecessors)
  ["claude-fable-5-1", { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }],
  ["claude-opus-5-5", { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
  ["claude-sonnet-5-5", { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  ["claude-haiku-5-5", { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }],
  ["claude-sonnet-4-5", { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  ["claude-haiku-4-5", { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }],
  // OpenAI (approximate list prices; adjust in config)
  ["gpt-4o", { input: 2.5, output: 10 }],
  ["gpt-4o-mini", { input: 0.15, output: 0.6 }],
  ["gpt-4.1", { input: 2, output: 8 }],
  ["gpt-4.1-mini", { input: 0.4, output: 1.6 }],
  ["o3", { input: 2, output: 8 }],
  ["o4-mini", { input: 1.1, output: 4.4 }],
  // Mock provider (demo/offline) - priced like a mid-tier model so dashboards and budgets are meaningful
  ["mock-smart", { input: 3, output: 15 }],
  ["mock-fast", { input: 0.25, output: 1.25 }],
  // Embeddings
  ["text-embedding-3-small", { input: 0.02, output: 0 }],
  ["text-embedding-3-large", { input: 0.13, output: 0 }],
  ["voyage-3", { input: 0.06, output: 0 }],
]);

export function registerPricing(model: string, price: ModelPrice): void {
  PRICES.set(model, price);
}

export function getPricing(model: string): ModelPrice | undefined {
  if (PRICES.has(model)) return PRICES.get(model);
  // Prefix match handles dated snapshots, e.g. "gpt-4o-2024-11-20".
  for (const [key, price] of PRICES) if (model.startsWith(key)) return price;
  return undefined;
}

export function estimateCost(model: string, usage: Usage): number {
  const p = getPricing(model);
  if (!p) return 0;
  const perTok = (n: number, perM: number) => (n * perM) / 1_000_000;
  let cost = perTok(usage.inputTokens, p.input) + perTok(usage.outputTokens, p.output);
  if (usage.cacheReadTokens && p.cacheRead) cost += perTok(usage.cacheReadTokens, p.cacheRead);
  if (usage.cacheWriteTokens && p.cacheWrite) cost += perTok(usage.cacheWriteTokens, p.cacheWrite);
  return Math.round(cost * 1e8) / 1e8;
}

export function listPricing(): Array<{ model: string } & ModelPrice> {
  return [...PRICES].map(([model, p]) => ({ model, ...p }));
}
