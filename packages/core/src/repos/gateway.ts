import { createHash, randomBytes } from "node:crypto";
import type { Db, Row } from "../db.js";
import { bool, j, num, numOrNull, str, strOrNull } from "../db.js";
import { newId } from "../ids.js";
import type { ApiKey, Budget, GatewayRequest, Usage } from "../schema.js";

const rowReq = (r: Row): GatewayRequest => ({
  id: str(r.id), projectId: str(r.project_id), apiKeyId: strOrNull(r.api_key_id), requestedModel: str(r.requested_model), servedModel: str(r.served_model),
  provider: str(r.provider), route: str(r.route), status: num(r.status), cached: bool.dec(r.cached), fallbackDepth: num(r.fallback_depth),
  latencyMs: num(r.latency_ms), usage: j.dec<Usage>(r.usage, { inputTokens: 0, outputTokens: 0 }), costUsd: num(r.cost_usd),
  traceId: strOrNull(r.trace_id), error: strOrNull(r.error), createdAt: num(r.created_at),
});
const rowBudget = (r: Row): Budget => ({
  id: str(r.id), projectId: str(r.project_id), scope: str(r.scope), limitUsd: num(r.limit_usd), period: str(r.period) as Budget["period"],
  hardStop: bool.dec(r.hard_stop), createdAt: num(r.created_at),
});
const rowKey = (r: Row): ApiKey => ({
  id: str(r.id), projectId: str(r.project_id), name: str(r.name), prefix: str(r.prefix), hash: str(r.hash), scopes: j.dec<string[]>(r.scopes, []),
  createdAt: num(r.created_at), lastUsedAt: numOrNull(r.last_used_at), revokedAt: numOrNull(r.revoked_at),
});

export const hashKey = (secret: string) => createHash("sha256").update(secret).digest("hex");

function periodStart(period: Budget["period"], now = Date.now()): number {
  const d = new Date(now);
  switch (period) {
    case "daily": return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    case "weekly": { const day = d.getUTCDay(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day); }
    case "monthly": return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    case "total": return 0;
  }
}

export class GatewayRepo {
  constructor(private db: Db) {}

  record(input: Omit<GatewayRequest, "id" | "createdAt">): GatewayRequest {
    const r: GatewayRequest = { ...input, id: newId.gatewayRequest(), createdAt: Date.now() };
    this.db.run(
      `INSERT INTO gateway_requests (id, project_id, api_key_id, requested_model, served_model, provider, route, status, cached, fallback_depth, latency_ms, usage, cost_usd, trace_id, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      r.id, r.projectId, r.apiKeyId, r.requestedModel, r.servedModel, r.provider, r.route, r.status, bool.enc(r.cached), r.fallbackDepth, r.latencyMs,
      j.enc(r.usage), r.costUsd, r.traceId, r.error, r.createdAt,
    );
    return r;
  }
  list(projectId: string, limit = 100): GatewayRequest[] {
    return this.db.all("SELECT * FROM gateway_requests WHERE project_id = ? ORDER BY created_at DESC LIMIT ?", projectId, limit).map(rowReq);
  }
  stats(projectId: string, sinceMs: number): { requests: number; errors: number; cached: number; costUsd: number; byModel: Array<{ model: string; provider: string; requests: number; costUsd: number; avgLatencyMs: number }> } {
    const since = Date.now() - sinceMs;
    const tot = this.db.get<{ n: number; e: number; c: number; cost: number }>(
      "SELECT COUNT(*) n, SUM(status >= 400) e, SUM(cached) c, SUM(cost_usd) cost FROM gateway_requests WHERE project_id = ? AND created_at >= ?", projectId, since,
    );
    const byModel = this.db
      .all("SELECT served_model m, provider p, COUNT(*) n, SUM(cost_usd) cost, AVG(latency_ms) lat FROM gateway_requests WHERE project_id = ? AND created_at >= ? GROUP BY served_model, provider ORDER BY n DESC", projectId, since)
      .map((r) => ({ model: str(r.m), provider: str(r.p), requests: num(r.n), costUsd: num(r.cost), avgLatencyMs: num(r.lat) }));
    return { requests: num(tot?.n), errors: num(tot?.e), cached: num(tot?.c), costUsd: num(tot?.cost), byModel };
  }

  // Budgets
  setBudget(input: { projectId: string; scope: string; limitUsd: number; period: Budget["period"]; hardStop?: boolean }): Budget {
    const b: Budget = { id: newId.budget(), projectId: input.projectId, scope: input.scope, limitUsd: input.limitUsd, period: input.period, hardStop: input.hardStop ?? true, createdAt: Date.now() };
    this.db.run(
      `INSERT INTO budgets (id, project_id, scope, limit_usd, period, hard_stop, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, scope, period) DO UPDATE SET limit_usd = excluded.limit_usd, hard_stop = excluded.hard_stop`,
      b.id, b.projectId, b.scope, b.limitUsd, b.period, bool.enc(b.hardStop), b.createdAt,
    );
    return this.db.all("SELECT * FROM budgets WHERE project_id = ? AND scope = ? AND period = ?", b.projectId, b.scope, b.period).map(rowBudget)[0]!;
  }
  listBudgets(projectId: string): Array<Budget & { spentUsd: number }> {
    return this.db.all("SELECT * FROM budgets WHERE project_id = ?", projectId).map(rowBudget).map((b) => ({ ...b, spentUsd: this.spent(b) }));
  }
  deleteBudget(id: string): void {
    this.db.run("DELETE FROM budgets WHERE id = ?", id);
  }
  spent(b: Budget): number {
    const since = periodStart(b.period);
    const [kind, value] = b.scope.includes(":") ? (b.scope.split(":", 2) as [string, string]) : ["project", ""];
    let sql = "SELECT COALESCE(SUM(cost_usd), 0) s FROM gateway_requests WHERE project_id = ? AND created_at >= ?";
    const params: Array<string | number> = [b.projectId, since];
    if (kind === "key") { sql += " AND api_key_id = ?"; params.push(value); }
    else if (kind === "model") { sql += " AND (served_model = ? OR requested_model = ?)"; params.push(value, value); }
    const gw = num(this.db.get<{ s: number }>(sql, ...params)?.s);
    if (kind === "agent") {
      return num(this.db.get<{ s: number }>("SELECT COALESCE(SUM(cost_usd), 0) s FROM agent_runs WHERE project_id = ? AND agent_name = ? AND started_at >= ?", b.projectId, value, since)?.s);
    }
    return gw;
  }
  /** Returns the first exceeded hard-stop budget for the given scopes, if any. */
  checkBudgets(projectId: string, scopes: string[]): (Budget & { spentUsd: number }) | undefined {
    for (const b of this.listBudgets(projectId)) {
      if (!b.hardStop) continue;
      if (!scopes.includes(b.scope)) continue;
      if (b.spentUsd >= b.limitUsd) return b;
    }
    return undefined;
  }

  // API keys
  createKey(projectId: string, name: string, scopes: string[] = ["gateway"]): { key: ApiKey; secret: string } {
    const secret = `cru_${randomBytes(24).toString("base64url")}`;
    const key: ApiKey = { id: newId.apiKey(), projectId, name, prefix: secret.slice(0, 10), hash: hashKey(secret), scopes, createdAt: Date.now(), lastUsedAt: null, revokedAt: null };
    this.db.run("INSERT INTO api_keys (id, project_id, name, prefix, hash, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", key.id, projectId, name, key.prefix, key.hash, j.enc(scopes), key.createdAt);
    return { key, secret };
  }
  verifyKey(secret: string): ApiKey | undefined {
    const r = this.db.get("SELECT * FROM api_keys WHERE hash = ? AND revoked_at IS NULL", hashKey(secret));
    if (!r) return undefined;
    this.db.run("UPDATE api_keys SET last_used_at = ? WHERE id = ?", Date.now(), str(r.id));
    return rowKey(r);
  }
  listKeys(projectId: string): ApiKey[] {
    return this.db.all("SELECT * FROM api_keys WHERE project_id = ? ORDER BY created_at DESC", projectId).map(rowKey);
  }
  revokeKey(id: string): void {
    this.db.run("UPDATE api_keys SET revoked_at = ? WHERE id = ?", Date.now(), id);
  }
}
