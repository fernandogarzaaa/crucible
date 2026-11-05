import { useEffect, useState } from "react";
import { api, fmt, sse } from "../lib/api";
import { useFetch, useProject } from "../lib/hooks";
import { Link, match, navigate, useRoute } from "../lib/router";
import { Badge, Empty, Json, Progress, Tabs, toast } from "../components/ui";

export function Evals() {
  const { path } = useRoute();
  const id = match("/evals/:id", path)?.id;
  return id ? <EvalDetail id={id} /> : <EvalList />;
}

function EvalList() {
  const project = useProject();
  const { data, reload } = useFetch<any[]>(`/api/projects/${project}/evals`, { pollMs: 3000 });
  const [creating, setCreating] = useState(false);
  return <>
    <div className="head"><div><h1>Evals</h1><div className="sub">Score a prompt version or an HTTP target against a dataset. Compare against a baseline to catch regressions.</div></div><button className="primary" onClick={() => setCreating(true)}>New eval</button></div>
    {creating && <EvalCreator project={project} onDone={(id) => { setCreating(false); reload(); if (id) navigate(`/evals/${id}`); }} />}
    {data && data.length === 0 && <Empty>No evals yet. Create one here or run <code>crucible eval run evals/example.eval.json</code>.</Empty>}
    {data && data.length > 0 && <div className="card tight"><table><thead><tr><th>Name</th><th>Status</th><th>Result</th><th className="right">Items</th><th>Scores</th><th className="right">Cost</th><th className="right">Created</th></tr></thead>
      <tbody>{data.map((e) => { const s = e.summary ?? {}; return <tr key={e.id} className="click" onClick={() => navigate(`/evals/${e.id}`)}><td>{e.name}{e.baselineEvalId && <div className="dim small">vs baseline</div>}</td><td><Badge kind={e.status}>{e.status}</Badge>{e.job?.status === "running" && <div style={{ width: 90, marginTop: 4 }}><Progress value={e.job.total ? e.job.done / e.job.total : 0} /></div>}</td>
        <td>{s.passed === true && <Badge kind="ok">passed</Badge>}{s.passed === false && <Badge kind="error">failed{s.regressions ? ` · ${s.regressions} regressions` : ""}</Badge>}</td><td className="right">{s.items ?? ""}</td>
        <td className="pill-row">{Object.entries(s.scores ?? {}).map(([k, v]: any) => <Badge key={k} kind={v.passRate === 1 ? "ok" : v.passRate === null ? "" : v.passRate < 0.5 ? "error" : "warn"}>{k} {v.passRate !== null ? fmt.pct(v.passRate) : v.mean.toFixed(2)}</Badge>)}</td><td className="right mono">{fmt.usd(s.costUsd)}</td><td className="right muted">{fmt.ago(e.createdAt)}</td></tr>; })}</tbody></table></div>}
  </>;
}

const SCORER_PRESETS: Record<string, any> = {
  exact_match: { type: "exact_match" }, contains: { type: "contains" }, regex: { type: "regex", pattern: "^\\s*\\S" }, json_schema: { type: "json_schema", schema: { type: "object" } },
  levenshtein: { type: "levenshtein", threshold: 0.8 }, latency: { type: "latency", maxMs: 5000 }, cost: { type: "cost", maxUsd: 0.01 },
  llm_judge: { type: "llm_judge", model: "fast", rubric: "Is the response correct, helpful and concise?", scale: [1, 5], passThreshold: 4 },
};

function EvalCreator({ project, onDone }: { project: string; onDone: (id?: string) => void }) {
  const { data: datasets } = useFetch<any[]>(`/api/projects/${project}/datasets`);
  const { data: prompts } = useFetch<any[]>(`/api/projects/${project}/prompts`);
  const { data: evals } = useFetch<any[]>(`/api/projects/${project}/evals`);
  const [name, setName] = useState(""); const [datasetId, setDatasetId] = useState(""); const [promptName, setPromptName] = useState(""); const [versions, setVersions] = useState<any[]>([]); const [versionId, setVersionId] = useState("");
  const [targetUrl, setTargetUrl] = useState(""); const [baseline, setBaseline] = useState("");
  const [scorers, setScorers] = useState<any[]>([SCORER_PRESETS.contains, SCORER_PRESETS.latency]);
  useEffect(() => { if (promptName) api.get(`/api/projects/${project}/prompts/${encodeURIComponent(promptName)}`).then((p) => { setVersions(p.versions); setVersionId(p.versions[0]?.id ?? ""); }); }, [promptName]);
  const create = async () => {
    try { const e = await api.post(`/api/projects/${project}/evals`, { name, datasetId, promptVersionId: versionId || null, target: targetUrl ? { url: targetUrl } : undefined, scorers, baselineEvalId: baseline || null, run: true }); onDone(e.id); } catch (e) { toast((e as Error).message, true); }
  };
  return <div className="card" style={{ marginBottom: 14, borderColor: "var(--accent)" }}>
    <div className="grid g3"><label>name<input value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label>dataset<select value={datasetId} onChange={(e) => setDatasetId(e.target.value)}><option value="">choose…</option>{datasets?.map((d) => <option key={d.id} value={d.id}>{d.name} ({d.itemCount})</option>)}</select></label>
      <label>baseline (optional)<select value={baseline} onChange={(e) => setBaseline(e.target.value)}><option value="">none</option>{evals?.filter((e) => e.status === "completed").map((e) => <option key={e.id} value={e.id}>{e.name} · {fmt.ago(e.createdAt)}</option>)}</select></label>
      <label>prompt<select value={promptName} onChange={(e) => setPromptName(e.target.value)}><option value="">(use HTTP target)</option>{prompts?.map((p) => <option key={p.id} value={p.name}>{p.name}</option>)}</select></label>
      <label>version<select value={versionId} onChange={(e) => setVersionId(e.target.value)} disabled={!promptName}>{versions.map((v) => <option key={v.id} value={v.id}>v{v.version}{v.labels.length ? ` (${v.labels.join(",")})` : ""}</option>)}</select></label>
      <label>or HTTP target URL<input value={targetUrl} onChange={(e) => setTargetUrl(e.target.value)} placeholder="https://my-app/answer" disabled={!!promptName} /></label></div>
    <h2 style={{ marginTop: 12 }}>Scorers</h2>
    <div className="pill-row" style={{ marginBottom: 8 }}>{Object.keys(SCORER_PRESETS).map((k) => <button key={k} className="sm" onClick={() => setScorers([...scorers, SCORER_PRESETS[k]])}>+ {k}</button>)}</div>
    {scorers.map((s, i) => <div key={i} className="row" style={{ marginBottom: 6 }}><Badge>{s.type}</Badge><input className="mono" style={{ flex: 1 }} value={JSON.stringify(s)} onChange={(e) => { try { setScorers(scorers.map((x, j) => j === i ? JSON.parse(e.target.value) : x)); } catch { /* keep typing */ } }} /><button className="sm" onClick={() => setScorers(scorers.filter((_, j) => j !== i))}>×</button></div>)}
    <div className="row" style={{ marginTop: 10, justifyContent: "flex-end" }}><button onClick={() => onDone()}>Cancel</button><button className="primary" disabled={!name || !datasetId || (!versionId && !targetUrl) || !scorers.length} onClick={create}>Create and run</button></div>
  </div>;
}

function EvalDetail({ id }: { id: string }) {
  const { data, reload } = useFetch<any>(`/api/evals/${id}`, { deps: [id] });
  const [progress, setProgress] = useState<any>(null);
  const [tab, setTab] = useState<"results" | "regressions" | "config">("results");
  const [filter, setFilter] = useState<"all" | "failed">("all");
  useEffect(() => { const off = sse(`/api/evals/${id}/progress`, (_, d) => { setProgress(d); if (d.status !== "running") reload(); }); return off; }, [id]);
  if (!data) return <div className="muted">Loading…</div>;
  const s = data.summary;
  const results = (data.results as any[]).filter((r) => filter === "all" || r.error || r.scores.some((x: any) => x.passed === false));
  return <>
    <div className="head"><div><h1>{data.name}</h1><div className="sub">{data.promptVersion ? <>prompt version <code>v{data.promptVersion.version}</code> · model <code>{data.promptVersion.config.model}</code></> : <>HTTP target <code>{data.target?.url}</code></>} · {fmt.time(data.createdAt)}</div></div>
      <div className="row"><Badge kind={data.status}>{data.status}</Badge>{data.summary?.passed === true && <Badge kind="ok">passed</Badge>}{data.summary?.passed === false && <Badge kind="error">failed</Badge>}<button onClick={async () => { await api.post(`/api/evals/${id}/run`); toast("re-running"); }}>Re-run</button><Link to="/evals" className="btn">← all evals</Link></div></div>
    {progress?.status === "running" && <div className="card" style={{ marginBottom: 14 }}><div className="row small muted" style={{ justifyContent: "space-between" }}><span>Running…</span><span>{progress.done}/{progress.total}</span></div><Progress value={progress.total ? progress.done / progress.total : 0} /></div>}
    <div className="grid g4" style={{ marginBottom: 14 }}>
      <div className="card stat"><div className="l">Items</div><div className="v">{s.items}</div><div className="d">{s.errors} errors</div></div>
      <div className="card stat"><div className="l">Cost</div><div className="v">{fmt.usd(s.costUsd)}</div><div className="d">avg latency {fmt.ms(s.avgLatencyMs)}</div></div>
      {Object.entries(s.scores).slice(0, 2).map(([k, v]: any) => <div key={k} className="card stat"><div className="l">{k}</div><div className="v">{v.passRate !== null ? fmt.pct(v.passRate) : v.mean.toFixed(3)}</div><div className="d">mean {v.mean.toFixed(3)} · n={v.n}</div></div>)}
    </div>
    {data.compare && <div className="card" style={{ marginBottom: 14, borderColor: data.compare.regressions.length ? "#7f1d1d" : "#14532d" }}><strong>vs baseline:</strong> <span style={{ color: data.compare.regressions.length ? "var(--err)" : "var(--ok)" }}>{data.compare.regressions.length} regressions</span> · {data.compare.improvements.length} improvements · <Link to={`/evals/${data.baselineEvalId}`}>open baseline</Link></div>}
    <Tabs tabs={[["results", `Results (${data.results.length})`], ["regressions", "Regressions"], ["config", "Config"]]} value={tab} onChange={setTab} />
    {tab === "results" && <>
      <div className="row" style={{ marginBottom: 8 }}><button className={`sm ${filter === "all" ? "primary" : ""}`} onClick={() => setFilter("all")}>All</button><button className={`sm ${filter === "failed" ? "primary" : ""}`} onClick={() => setFilter("failed")}>Failed only</button></div>
      <div className="card tight"><table><thead><tr><th>Input</th><th>Expected</th><th>Output</th><th>Scores</th><th className="right">Latency</th><th></th></tr></thead>
        <tbody>{results.map((r) => <tr key={r.id}><td style={{ maxWidth: 260 }}><Json value={r.item?.input ?? r.itemId} max={400} /></td><td style={{ maxWidth: 200 }}><Json value={r.item?.expected ?? null} max={300} /></td><td style={{ maxWidth: 320 }}>{r.error ? <span style={{ color: "var(--err)" }} className="mono small">{r.error}</span> : <Json value={r.output} max={500} />}</td>
          <td>{r.scores.map((x: any) => <div key={x.name} className="small"><Badge kind={x.passed === false ? "error" : x.passed === true ? "ok" : ""}>{x.name} {x.value.toFixed(2)}</Badge>{x.reason && <div className="dim" style={{ maxWidth: 220 }}>{fmt.short(x.reason, 120)}</div>}</div>)}</td>
          <td className="right small">{fmt.ms(r.latencyMs)}<div className="dim">{fmt.usd(r.costUsd)}</div></td><td>{r.traceId && <Link to={`/traces/${r.traceId}`} className="small">trace</Link>}</td></tr>)}</tbody></table>{results.length === 0 && <div className="muted small" style={{ padding: 10 }}>No results{filter === "failed" ? " failed" : " yet"}.</div>}</div></>}
    {tab === "regressions" && (data.compare ? <div className="card tight"><table><thead><tr><th>Item</th><th>Scorer</th><th className="right">Baseline</th><th className="right">Now</th></tr></thead><tbody>{[...data.compare.regressions.map((x: any) => ({ ...x, kind: "error" })), ...data.compare.improvements.map((x: any) => ({ ...x, kind: "ok" }))].map((x: any, i: number) => <tr key={i}><td className="mono small">{x.itemId}</td><td>{x.scorer}</td><td className="right">{x.before.toFixed(2)}</td><td className="right" style={{ color: x.kind === "error" ? "var(--err)" : "var(--ok)" }}>{x.after.toFixed(2)}</td></tr>)}</tbody></table></div> : <Empty>No baseline selected for this eval.</Empty>)}
    {tab === "config" && <div className="card"><h2>Scorers</h2><Json value={data.scorers} />{data.promptVersion && <><h2 style={{ marginTop: 12 }}>Prompt template</h2><Json value={data.promptVersion.template} /></>}</div>}
  </>;
}
