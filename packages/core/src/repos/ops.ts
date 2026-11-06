import type { Db, Row } from "../db.js";
import { bool, j, num, numOrNull, str, strOrNull } from "../db.js";
import { newId } from "../ids.js";
import type { AlertRule, Approval, AuditEntry, Json } from "../schema.js";

const rowApproval = (r: Row): Approval => ({
  id: str(r.id), projectId: str(r.project_id), runId: str(r.run_id), eventSeq: num(r.event_seq), title: str(r.title), details: j.dec<Json>(r.details, null),
  status: str(r.status) as Approval["status"], requestedAt: num(r.requested_at), resolvedAt: numOrNull(r.resolved_at), resolvedBy: strOrNull(r.resolved_by), reason: strOrNull(r.reason),
});
const rowAudit = (r: Row): AuditEntry => ({
  id: str(r.id), projectId: strOrNull(r.project_id), actor: str(r.actor), action: str(r.action), targetType: str(r.target_type), targetId: str(r.target_id),
  details: j.dec<Record<string, Json>>(r.details, {}), ts: num(r.ts),
});
const rowAlert = (r: Row): AlertRule => ({
  id: str(r.id), projectId: str(r.project_id), name: str(r.name), metric: str(r.metric) as AlertRule["metric"], op: str(r.op) as AlertRule["op"],
  threshold: num(r.threshold), windowMinutes: num(r.window_minutes), enabled: bool.dec(r.enabled), lastFiredAt: numOrNull(r.last_fired_at), createdAt: num(r.created_at),
});

export class OpsRepo {
  constructor(private db: Db) {}

  // Approvals (human-in-the-loop)
  requestApproval(input: { projectId: string; runId: string; eventSeq: number; title: string; details?: Json }): Approval {
    const a: Approval = { id: newId.approval(), projectId: input.projectId, runId: input.runId, eventSeq: input.eventSeq, title: input.title, details: input.details ?? null, status: "pending", requestedAt: Date.now(), resolvedAt: null, resolvedBy: null, reason: null };
    this.db.run("INSERT INTO approvals (id, project_id, run_id, event_seq, title, details, status, requested_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", a.id, a.projectId, a.runId, a.eventSeq, a.title, j.enc(a.details), a.status, a.requestedAt);
    return a;
  }
  getApproval(id: string): Approval | undefined {
    const r = this.db.get("SELECT * FROM approvals WHERE id = ?", id);
    return r ? rowApproval(r) : undefined;
  }
  listApprovals(projectId: string, status?: Approval["status"]): Approval[] {
    return status
      ? this.db.all("SELECT * FROM approvals WHERE project_id = ? AND status = ? ORDER BY requested_at DESC", projectId, status).map(rowApproval)
      : this.db.all("SELECT * FROM approvals WHERE project_id = ? ORDER BY requested_at DESC LIMIT 200", projectId).map(rowApproval);
  }
  resolveApproval(id: string, status: "approved" | "rejected" | "expired", by: string, reason?: string): Approval | undefined {
    this.db.run("UPDATE approvals SET status = ?, resolved_at = ?, resolved_by = ?, reason = ? WHERE id = ? AND status = 'pending'", status, Date.now(), by, reason ?? null, id);
    return this.getApproval(id);
  }

  // Audit log
  audit(input: { projectId?: string | null; actor: string; action: string; targetType: string; targetId: string; details?: Record<string, Json> }): AuditEntry {
    const e: AuditEntry = { id: newId.audit(), projectId: input.projectId ?? null, actor: input.actor, action: input.action, targetType: input.targetType, targetId: input.targetId, details: input.details ?? {}, ts: Date.now() };
    this.db.run("INSERT INTO audit_log (id, project_id, actor, action, target_type, target_id, details, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", e.id, e.projectId, e.actor, e.action, e.targetType, e.targetId, j.enc(e.details), e.ts);
    return e;
  }
  auditLog(projectId: string | null, limit = 200): AuditEntry[] {
    return projectId
      ? this.db.all("SELECT * FROM audit_log WHERE project_id = ? OR project_id IS NULL ORDER BY ts DESC LIMIT ?", projectId, limit).map(rowAudit)
      : this.db.all("SELECT * FROM audit_log ORDER BY ts DESC LIMIT ?", limit).map(rowAudit);
  }

  // Alert rules
  createAlert(input: Omit<AlertRule, "id" | "createdAt" | "lastFiredAt" | "enabled"> & { enabled?: boolean }): AlertRule {
    const a: AlertRule = { ...input, id: newId.alert(), enabled: input.enabled ?? true, lastFiredAt: null, createdAt: Date.now() };
    this.db.run("INSERT INTO alert_rules (id, project_id, name, metric, op, threshold, window_minutes, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", a.id, a.projectId, a.name, a.metric, a.op, a.threshold, a.windowMinutes, bool.enc(a.enabled), a.createdAt);
    return a;
  }
  listAlerts(projectId: string): AlertRule[] {
    return this.db.all("SELECT * FROM alert_rules WHERE project_id = ? ORDER BY created_at", projectId).map(rowAlert);
  }
  markFired(id: string): void {
    this.db.run("UPDATE alert_rules SET last_fired_at = ? WHERE id = ?", Date.now(), id);
  }
  deleteAlert(id: string): void {
    this.db.run("DELETE FROM alert_rules WHERE id = ?", id);
  }

  // Simple KV for settings
  kvGet<T>(key: string, fallback: T): T {
    const r = this.db.get<{ value: string }>("SELECT value FROM kv WHERE key = ?", key);
    return r ? (JSON.parse(r.value) as T) : fallback;
  }
  kvSet(key: string, value: unknown): void {
    this.db.run("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", key, JSON.stringify(value), Date.now());
  }
}
