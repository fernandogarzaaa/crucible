/** Thin typed-ish client for the Crucible API. Types are intentionally loose here; the server validates. */
const BASE = (import.meta as unknown as { env: Record<string, string | undefined> }).env?.VITE_API_BASE ?? "";
let adminToken: string | null = localStorage.getItem("crucible.token");

export function setToken(t: string | null) { adminToken = t; if (t) localStorage.setItem("crucible.token", t); else localStorage.removeItem("crucible.token"); }

export class ApiError extends Error { constructor(readonly status: number, message: string) { super(message); } }

async function req<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method, headers: { "content-type": "application/json", ...(adminToken ? { authorization: `Bearer ${adminToken}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error?.message ?? data?.error ?? res.statusText);
  return data as T;
}
export const api = {
  get: <T = any>(p: string) => req<T>("GET", p),
  post: <T = any>(p: string, b?: unknown) => req<T>("POST", p, b),
  put: <T = any>(p: string, b?: unknown) => req<T>("PUT", p, b),
  del: <T = any>(p: string) => req<T>("DELETE", p),
};

/** Subscribe to a server-sent-events endpoint. Returns an unsubscribe function. */
export function sse(path: string, onEvent: (event: string, data: any) => void): () => void {
  const es = new EventSource(`${BASE}${path}`);
  const handler = (e: MessageEvent) => { try { onEvent(e.type, JSON.parse(e.data)); } catch { onEvent(e.type, e.data); } };
  for (const t of ["event", "progress", "runs", "approvals", "traces", "ping", "message"]) es.addEventListener(t, handler as EventListener);
  es.onerror = () => { /* browser auto-reconnects */ };
  return () => es.close();
}

export const fmt = {
  usd: (n: number | undefined | null) => (n == null ? "-" : `$${n < 0.01 ? n.toFixed(5) : n.toFixed(3)}`),
  ms: (n: number | undefined | null) => (n == null ? "-" : n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`),
  pct: (n: number | null | undefined) => (n == null ? "-" : `${Math.round(n * 100)}%`),
  num: (n: number | undefined | null) => (n == null ? "-" : n.toLocaleString()),
  ago: (ts: number | null | undefined) => { if (!ts) return "-"; const s = Math.max(0, (Date.now() - ts) / 1000); return s < 60 ? `${Math.round(s)}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`; },
  time: (ts: number | null | undefined) => (ts ? new Date(ts).toLocaleString() : "-"),
  short: (s: string | null | undefined, n = 80) => (s == null ? "" : s.length > n ? s.slice(0, n - 1) + "…" : s),
  json: (v: unknown, n = 120) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s == null ? "" : s.length > n ? s.slice(0, n - 1) + "…" : s; },
};
