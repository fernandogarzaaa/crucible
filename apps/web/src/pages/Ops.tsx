import { useState } from "react";
import { api, fmt } from "../lib/api";
import { useFetch, useProject } from "../lib/hooks";
import { Link } from "../lib/router";
import { Badge, Empty, Json, Tabs, confirmThen, toast } from "../components/ui";

export function Ops() {
  const project = useProject();
  const [tab, setTab] = useState<"approvals" | "alerts" | "audit">("approvals");
  const { data: pending } = useFetch<any[]>(`/api/projects/${project}/approvals?status=pending`, { pollMs: 3000 });
  return <>
    <div className="head"><div><h1>Operate</h1><div className="sub">Human-in-the-loop approvals, alert rules and the audit trail of every operator action.</div></div>{pending && pending.length > 0 && <Badge kind="warn">{pending.length} waiting</Badge>}</div>
    <Tabs tabs={[["approvals", `Approvals${pending?.length ? ` (${pending.length})` : ""}`], ["alerts", "Alerts"], ["audit", "Audit log"]]} value={tab} onChange={setTab} />
    {tab === "approvals" && <Approvals project={project} />}
    {tab === "alerts" && <Alerts project={project} />}
    {tab === "audit" && <Audit project={project} />}
  </>;
}

function Approvals({ project }: { project: string }) {
  const { data, reload } = useFetch<any[]>(`/api/projects/${project}/approvals`, { pollMs: 3000 });
  const resolve = async (id: string, status: "approved" | "rejected") => { const reason = status === "rejected" ? prompt("Reason (optional)") ?? undefined : undefined; try { await api.post(`/api/approvals/${id}/resolve`, { status, reason }); toast(status); reload(); } catch (e) { toast((e as Error).message, true); } };
  if (!data) return null;
  const pending = data.filter((a) => a.status === "pending"), done = data.filter((a) => a.status !== "pending");
  return <>
    {pending.length === 0 && <Empty>Nothing waiting for a human. Tools marked <code>requiresApproval</code> pause here.</Empty>}
    {pending.map((a) => <div key={a.id} className="card" style={{ borderColor: "#78350f", marginBottom: 10 }}><div className="row" style={{ justifyContent: "space-between" }}><div><strong>{a.title}</strong><div className="small muted">run <Link to={`/runs/${a.runId}`} className="mono">{a.runId}</Link> · event #{a.eventSeq} · {fmt.ago(a.requestedAt)}</div><Json value={a.details} max={800} /></div><div className="row"><button className="primary" onClick={() => resolve(a.id, "approved")}>Approve</button><button className="danger" onClick={() => resolve(a.id, "rejected")}>Reject</button></div></div></div>)}
    {done.length > 0 && <div className="card tight" style={{ marginTop: 14 }}><table><thead><tr><th>Title</th><th>Run</th><th>Status</th><th>By</th><th>Reason</th><th className="right">Resolved</th></tr></thead><tbody>{done.map((a) => <tr key={a.id}><td>{a.title}</td><td><Link to={`/runs/${a.runId}`} className="mono small">{a.runId.slice(-8)}</Link></td><td><Badge kind={a.status}>{a.status}</Badge></td><td>{a.resolvedBy}</td><td className="muted">{a.reason}</td><td className="right muted">{fmt.ago(a.resolvedAt)}</td></tr>)}</tbody></table></div>}
  </>;
}

function Alerts({ project }: { project: string }) {
  const { data, reload } = useFetch<any[]>(`/api/projects/${project}/alerts`, { pollMs: 10000 });
  const [name, setName] = useState(""); const [metric, setMetric] = useState("error_rate"); const [op, setOp] = useState(">"); const [threshold, setThreshold] = useState("0.1"); const [win, setWin] = useState("60");
  return <div className="split">
    <div className="card"><h2>New alert rule</h2><div className="grid g2"><label>name<input value={name} onChange={(e) => setName(e.target.value)} /></label><label>metric<select value={metric} onChange={(e) => setMetric(e.target.value)}><option value="error_rate">error_rate (0-1)</option><option value="cost_usd">cost_usd</option><option value="latency_p95_ms">latency_p95_ms</option><option value="requests">requests</option><option value="approval_pending_count">approval_pending_count</option></select></label><label>op<select value={op} onChange={(e) => setOp(e.target.value)}><option>&gt;</option><option>&gt;=</option><option>&lt;</option><option>&lt;=</option></select></label><label>threshold<input value={threshold} onChange={(e) => setThreshold(e.target.value)} /></label><label>window (minutes)<input value={win} onChange={(e) => setWin(e.target.value)} /></label></div>
      <button className="primary sm" style={{ marginTop: 8 }} disabled={!name} onClick={async () => { try { await api.post(`/api/projects/${project}/alerts`, { name, metric, op, threshold: Number(threshold), windowMinutes: Number(win) }); setName(""); reload(); } catch (e) { toast((e as Error).message, true); } }}>Create</button>
      <div className="muted small" style={{ marginTop: 8 }}>Rules are evaluated when the overview or this page loads and whenever <code>/api/projects/:p/alerts</code> is polled. Firing rules write an <code>alert.fire</code> audit entry once per window.</div></div>
    <div className="card tight">{data?.length === 0 && <div className="muted small" style={{ padding: 10 }}>No rules.</div>}{data && data.length > 0 && <table><thead><tr><th>Rule</th><th>Condition</th><th className="right">Current</th><th>State</th><th></th></tr></thead><tbody>{data.map((a) => <tr key={a.id}><td>{a.name}</td><td className="mono small">{a.metric} {a.op} {a.threshold} / {a.windowMinutes}m</td><td className="right mono">{Number(a.current.value).toFixed(3)}</td><td><Badge kind={a.current.firing ? "error" : "ok"}>{a.current.firing ? "firing" : "ok"}</Badge></td><td><button className="sm danger" onClick={() => confirmThen("Delete rule?", () => api.del(`/api/alerts/${a.id}`).then(reload))}>×</button></td></tr>)}</tbody></table>}</div>
  </div>;
}

function Audit({ project }: { project: string }) {
  const { data } = useFetch<any[]>(`/api/projects/${project}/audit?limit=300`, { pollMs: 5000 });
  if (!data) return null;
  if (!data.length) return <Empty>No operator actions recorded yet.</Empty>;
  return <div className="card tight"><table><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>Details</th></tr></thead><tbody>{data.map((e) => <tr key={e.id}><td className="muted nowrap">{fmt.ago(e.ts)}</td><td>{e.actor}</td><td><Badge>{e.action}</Badge></td><td className="mono small">{e.targetType}:{e.targetId.slice(-10)}</td><td className="small muted">{fmt.json(e.details, 140)}</td></tr>)}</tbody></table></div>;
}
