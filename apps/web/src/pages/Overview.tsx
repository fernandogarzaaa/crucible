import { useFetch, useProject } from "../lib/hooks";
import { fmt } from "../lib/api";
import { Link } from "../lib/router";
import { Badge, Empty, Stat } from "../components/ui";

export function Overview() {
  const project = useProject();
  const { data, error } = useFetch<any>(`/api/projects/${project}/overview`, { pollMs: 5000 });
  if (error) return <Empty>{error}</Empty>;
  if (!data) return <div className="muted">Loading…</div>;
  const { traces, gateway, fleet, pendingApprovals, budgets, firingAlerts, recentEvals, recentRuns, counts } = data;
  const empty = traces.traces === 0 && gateway.requests === 0 && recentRuns.length === 0;
  return (
    <>
      <div className="head"><div><h1>Overview</h1><div className="sub">Last 24 hours · project <code>{project}</code></div></div>
        <div className="row"><Link to="/gateway" className="btn">Try the gateway</Link><Link to="/agents" className="btn">Run an agent</Link></div></div>
      {firingAlerts.length > 0 && <div className="card" style={{ borderColor: "#7f1d1d", marginBottom: 14 }}><strong style={{ color: "var(--err)" }}>{firingAlerts.length} alert{firingAlerts.length > 1 ? "s" : ""} firing</strong>
        <div className="pill-row" style={{ marginTop: 6 }}>{firingAlerts.map((a: any) => <Badge key={a.id} kind="error">{a.name}: {a.metric} = {Number(a.current.value).toFixed(2)} {a.op} {a.threshold}</Badge>)}</div></div>}
      {empty && <Empty>Nothing recorded yet. Point an OpenAI or Anthropic SDK at <code>http://localhost:4800/v1</code>, instrument your app with <code>@crucible/sdk</code>, or run <code>crucible eval run evals/example.eval.json</code>.</Empty>}
      <div className="grid g4" style={{ marginTop: 14 }}>
        <Stat label="Traces" value={fmt.num(traces.traces)} detail={<>{traces.errors} errors · p95 {fmt.ms(traces.p95Ms)}</>} />
        <Stat label="Gateway requests" value={fmt.num(gateway.requests)} detail={<>{gateway.cached} cached · {gateway.errors} failed</>} />
        <Stat label="Spend" value={fmt.usd(gateway.costUsd + traces.costUsd)} detail={<>{fmt.num(traces.tokens)} tokens traced</>} />
        <Stat label="Pending approvals" value={pendingApprovals} detail={<Link to="/ops">review</Link>} />
      </div>
      <div className="grid g2" style={{ marginTop: 14 }}>
        <div className="card"><h2>Agent fleet</h2>
          {fleet.length === 0 ? <div className="muted small">No agent runs in window.</div> : <table><thead><tr><th>Agent</th><th className="right">Runs</th><th className="right">Running</th><th className="right">Failed</th><th className="right">Waiting</th><th className="right">Cost</th><th className="right">Avg</th></tr></thead>
            <tbody>{fleet.map((f: any) => <tr key={f.agentName}><td><Link to={`/agents?agent=${f.agentName}`}>{f.agentName}</Link></td><td className="right">{f.runs}</td><td className="right">{f.running || ""}</td><td className="right" style={{ color: f.failed ? "var(--err)" : undefined }}>{f.failed || ""}</td><td className="right" style={{ color: f.awaitingApproval ? "var(--warn)" : undefined }}>{f.awaitingApproval || ""}</td><td className="right">{fmt.usd(f.costUsd)}</td><td className="right">{fmt.ms(f.avgDurationMs)}</td></tr>)}</tbody></table>}
        </div>
        <div className="card"><h2>Spend by model</h2>
          {gateway.byModel.length === 0 ? <div className="muted small">No gateway traffic yet.</div> : <table><thead><tr><th>Model</th><th>Provider</th><th className="right">Req</th><th className="right">Avg latency</th><th className="right">Cost</th></tr></thead>
            <tbody>{gateway.byModel.map((m: any) => <tr key={m.model + m.provider}><td className="mono">{m.model}</td><td>{m.provider}</td><td className="right">{m.requests}</td><td className="right">{fmt.ms(m.avgLatencyMs)}</td><td className="right">{fmt.usd(m.costUsd)}</td></tr>)}</tbody></table>}
          {budgets.length > 0 && <div style={{ marginTop: 12 }}><h2>Budgets</h2>{budgets.map((b: any) => <div key={b.id} className="row small" style={{ justifyContent: "space-between", marginBottom: 6 }}><span>{b.scope} · {b.period}</span><span className="mono">{fmt.usd(b.spentUsd)} / {fmt.usd(b.limitUsd)}</span><div className="bar" style={{ width: "100%" }}><i className={b.spentUsd >= b.limitUsd ? "err" : ""} style={{ width: `${Math.min(100, (b.spentUsd / b.limitUsd) * 100)}%` }} /></div></div>)}</div>}
        </div>
        <div className="card"><h2>Recent evals</h2>
          {recentEvals.length === 0 ? <div className="muted small">No evals yet.</div> : <table><tbody>{recentEvals.map((e: any) => <tr key={e.id}><td><Link to={`/evals/${e.id}`}>{e.name}</Link></td><td><Badge kind={e.status}>{e.status}</Badge></td><td>{e.summary?.passed === true ? <Badge kind="ok">passed</Badge> : e.summary?.passed === false ? <Badge kind="error">failed</Badge> : null}</td><td className="right muted">{fmt.ago(e.createdAt)}</td></tr>)}</tbody></table>}
        </div>
        <div className="card"><h2>Recent runs</h2>
          {recentRuns.length === 0 ? <div className="muted small">No runs yet.</div> : <table><tbody>{recentRuns.map((r: any) => <tr key={r.id}><td><Link to={`/runs/${r.id}`}>{r.agentName}</Link> {r.parentRunId && <span className="dim small">fork</span>}</td><td><Badge kind={r.status}>{r.status}</Badge></td><td className="right mono">{fmt.usd(r.costUsd)}</td><td className="right muted">{fmt.ago(r.startedAt)}</td></tr>)}</tbody></table>}
        </div>
      </div>
      <div className="row dim small" style={{ marginTop: 14 }}>{counts.prompts} prompts · {counts.datasets} datasets · {counts.kbs} knowledge bases</div>
    </>
  );
}
