import type { Gateway } from "@crucible/gateway";
import type { Json, Score, ScorerConfig } from "@crucible/core";

export interface ScoreContext {
  input: Record<string, Json>;
  output: Json;
  expected: Json | undefined;
  latencyMs: number;
  costUsd: number;
  metadata?: Record<string, Json>;
}

export interface Scorer {
  name: string;
  score(ctx: ScoreContext): Promise<Score>;
}

const asText = (v: Json): string => (typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v));

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n]!;
}

/** Small JSON-Schema subset validator: type, required, properties, items, enum, minimum/maximum, minLength/maxLength. */
export function validateJsonSchema(value: unknown, schema: Record<string, unknown>, path = "$"): string[] {
  const errs: string[] = [];
  const type = schema.type as string | string[] | undefined;
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value === "number" && Number.isInteger(value) ? "integer" : typeof value;
  if (type) {
    const types = Array.isArray(type) ? type : [type];
    const ok = types.some((t) => t === actual || (t === "number" && actual === "integer"));
    if (!ok) errs.push(`${path}: expected ${types.join("|")}, got ${actual}`);
  }
  if (schema.enum && Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) errs.push(`${path}: not in enum`);
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errs.push(`${path}: < minimum`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errs.push(`${path}: > maximum`);
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) errs.push(`${path}: shorter than minLength`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) errs.push(`${path}: longer than maxLength`);
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) errs.push(`${path}: pattern mismatch`);
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const r of (schema.required as string[] | undefined) ?? []) if (!(r in obj)) errs.push(`${path}.${r}: required`);
    const props = (schema.properties as Record<string, Record<string, unknown>> | undefined) ?? {};
    for (const [k, sub] of Object.entries(props)) if (k in obj) errs.push(...validateJsonSchema(obj[k], sub, `${path}.${k}`));
    if (schema.additionalProperties === false) for (const k of Object.keys(obj)) if (!(k in props)) errs.push(`${path}.${k}: additional property`);
  }
  if (Array.isArray(value) && schema.items && typeof schema.items === "object") {
    value.forEach((v, i) => errs.push(...validateJsonSchema(v, schema.items as Record<string, unknown>, `${path}[${i}]`)));
  }
  return errs;
}

function parseMaybeJson(s: string): unknown {
  try { return JSON.parse(s); } catch {
    const m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (m) { try { return JSON.parse(m[1]!); } catch { /* fallthrough */ } }
    return undefined;
  }
}

export interface ScorerDeps { gateway?: Gateway; projectId: string; customLoader?: (module: string) => Promise<{ score: Scorer["score"] }> }

export function buildScorer(cfg: ScorerConfig, deps: ScorerDeps): Scorer {
  switch (cfg.type) {
    case "exact_match":
      return { name: "exact_match", async score({ output, expected }) {
        const o = cfg.field && output && typeof output === "object" ? (output as Record<string, Json>)[cfg.field] : output;
        const ok = asText(o ?? null).trim() === asText(expected ?? null).trim();
        return { name: "exact_match", value: ok ? 1 : 0, passed: ok };
      } };
    case "contains":
      return { name: "contains", async score({ output, expected }) {
        const needle = cfg.value ?? asText(expected ?? null);
        const hay = asText(output);
        const ok = cfg.caseSensitive ? hay.includes(needle) : hay.toLowerCase().includes(needle.toLowerCase());
        return { name: "contains", value: ok ? 1 : 0, passed: ok, reason: ok ? undefined : `missing "${needle.slice(0, 60)}"` };
      } };
    case "regex":
      return { name: "regex", async score({ output }) {
        const ok = new RegExp(cfg.pattern, cfg.flags).test(asText(output));
        return { name: "regex", value: ok ? 1 : 0, passed: ok };
      } };
    case "json_schema":
      return { name: "json_schema", async score({ output }) {
        const val = typeof output === "string" ? parseMaybeJson(output) : output;
        if (val === undefined) return { name: "json_schema", value: 0, passed: false, reason: "output is not valid JSON" };
        const errs = validateJsonSchema(val, cfg.schema);
        return { name: "json_schema", value: errs.length ? 0 : 1, passed: !errs.length, reason: errs.slice(0, 3).join("; ") || undefined };
      } };
    case "levenshtein":
      return { name: "levenshtein", async score({ output, expected }) {
        const a = asText(output), b = asText(expected ?? null);
        const sim = 1 - levenshtein(a, b) / Math.max(a.length, b.length, 1);
        const th = cfg.threshold ?? 0.8;
        return { name: "levenshtein", value: Math.round(sim * 1000) / 1000, passed: sim >= th };
      } };
    case "latency":
      return { name: "latency", async score({ latencyMs }) { const ok = latencyMs <= cfg.maxMs; return { name: "latency", value: ok ? 1 : 0, passed: ok, reason: `${Math.round(latencyMs)}ms` }; } };
    case "cost":
      return { name: "cost", async score({ costUsd }) { const ok = costUsd <= cfg.maxUsd; return { name: "cost", value: ok ? 1 : 0, passed: ok, reason: `$${costUsd.toFixed(5)}` }; } };
    case "llm_judge":
      return { name: "llm_judge", async score(ctx) {
        if (!deps.gateway) return { name: "llm_judge", value: 0, passed: false, reason: "no gateway configured for judge" };
        const [lo, hi] = cfg.scale;
        const prompt = [
          `You are a strict evaluator. Score the RESPONSE against the RUBRIC on a scale from ${lo} to ${hi}.`,
          `Reply with JSON only: {"score": <number>, "reason": "<one sentence>"}.`,
          ``, `RUBRIC:\n${cfg.rubric}`, ``, `INPUT:\n${JSON.stringify(ctx.input, null, 2)}`,
          ctx.expected !== undefined ? `\nEXPECTED (reference, may be partial):\n${asText(ctx.expected)}` : "",
          ``, `RESPONSE:\n${asText(ctx.output)}`,
        ].join("\n");
        const res = await deps.gateway.chat({ messages: [{ role: "user", content: prompt }], config: { model: cfg.model, temperature: 0, maxTokens: 300 } }, { projectId: deps.projectId, scopes: ["project"] });
        const text = typeof res.message.content === "string" ? res.message.content : res.message.content.map((p) => (p.type === "text" ? p.text : "")).join("");
        const parsed = parseMaybeJson(text) as { score?: number; reason?: string } | undefined;
        const raw = typeof parsed?.score === "number" ? parsed.score : Number((text.match(/-?\d+(\.\d+)?/) ?? ["NaN"])[0]);
        if (Number.isNaN(raw)) return { name: "llm_judge", value: 0, passed: false, reason: `unparseable judge output: ${text.slice(0, 80)}` };
        const norm = hi === lo ? 0 : (Math.min(hi, Math.max(lo, raw)) - lo) / (hi - lo);
        const th = cfg.passThreshold !== undefined ? (cfg.passThreshold - lo) / (hi - lo) : undefined;
        return { name: "llm_judge", value: Math.round(norm * 1000) / 1000, passed: th === undefined ? undefined : norm >= th, reason: parsed?.reason };
      } };
    case "custom":
      return { name: `custom:${cfg.module}`, async score(ctx) {
        const loader = deps.customLoader ?? (async (m: string) => (await import(m)) as { score: Scorer["score"] });
        const mod = await loader(cfg.module);
        const s = await mod.score({ ...ctx, metadata: { ...(ctx.metadata ?? {}), options: cfg.options ?? {} } });
        return { ...s, name: s.name || `custom:${cfg.module}` };
      } };
  }
}
