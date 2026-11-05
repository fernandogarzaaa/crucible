import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Load KEY=VALUE pairs from .env into process.env (does not override existing values). */
export function loadDotenv(file = ".env"): void {
  const p = resolve(process.cwd(), file);
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    let v = m[2]!;
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1]! in process.env)) process.env[m[1]!] = v;
  }
}

export function readJson(path: string): unknown {
  const text = readFileSync(resolve(process.cwd(), path), "utf8");
  if (path.endsWith(".jsonl")) return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  return JSON.parse(text);
}

export const fmt = {
  usd: (n: number) => `$${n.toFixed(n < 0.01 ? 5 : 3)}`,
  ms: (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`),
  pct: (n: number | null) => (n === null ? "-" : `${Math.round(n * 100)}%`),
  ago: (ts: number) => { const s = Math.max(0, (Date.now() - ts) / 1000); return s < 60 ? `${Math.round(s)}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`; },
};

export function table(rows: Array<Record<string, unknown>>, cols?: string[]): string {
  if (!rows.length) return "(none)";
  const keys = cols ?? Object.keys(rows[0]!);
  const str = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
  const widths = keys.map((k) => Math.min(60, Math.max(k.length, ...rows.map((r) => str(r[k]).length))));
  const line = (vals: string[]) => vals.map((v, i) => v.slice(0, widths[i]).padEnd(widths[i]!)).join("  ");
  return [line(keys), line(widths.map((w) => "-".repeat(w))), ...rows.map((r) => line(keys.map((k) => str(r[k]))))].join("\n");
}

export class CliError extends Error {}
export function die(msg: string, code = 1): never { console.error(`error: ${msg}`); process.exit(code); }
