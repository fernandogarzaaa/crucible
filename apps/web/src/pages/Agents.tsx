import { useEffect, useMemo, useState } from "react";
import { api, fmt, sse } from "../lib/api";
import { useFetch, useProject } from "../lib/hooks";
import { Link, match, navigate, useRoute } from "../lib/router";
import { Badge, Empty, Json, KV, Tabs, confirmThen, toast } from "../components/ui";
import { TraceDetail } from "./Traces";

export function Agents() {
  const { path, query } = useRoute();
  const runId = match("/runs/:id", path)?.id;
  return runId ? <RunDetail id={runId} /> : <AgentList agentFilter={query.get("agent") ?? ""} />;
}

function AgentList({ agentFilter }: { agentFilter: string }) {
  const project = useProject();
  const { data: defs } = useFetch<any[]>("/api/agents");
  const [status, setStatus] = useState("");
  const [agent, setAgent] = useState(agentFilter);
  const q = new URLSearchParams({ limit: "100", ...(status ? { status } : {}), ...(agent ? { agent } : {}) });
  const { data: runs, reload } = useFetch<any[]>(`/api/projects/${project}/runs?${q}`, { pollMs: 3000 });
  const [input, setInput] = useState("");
  const [sel, setSel] = useState("");
  useEffect(() => { if (defs?.length && !sel) setSel(defs[0].name); }, [defs]);
  const start = async () => {
    try { const r = await api.post(`/api/projects/${project}/agents/${sel}/run`, { input }); toast("run started"); navigate(`/runs/${r.runId}`); } catch (e) { toast((e as Error).message, true); }
  };
  return <>
    <div className="head"><div><h1>Agents</h1><div className="sub">Every run is an event log you can replay, fork from any step, diff and kill.</div></div></div>
    <div className="card" style={{ marginBottom: 14 }}><h2>Start a run</h2>
      <div className="row"><select value={sel} onChange={(e) => setSel(e.target.value)}>{defs?.map((d) => <option key={d.name} value={d.name}>{d.name} · {d.model}</option>)}</select><input style={{ flex: 1, minWidth: 260 }} placeholder="What should the agent do?" value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && input && start()} /><button className="primary" disabled={!sel || !input} onClick={start}>Run</button></div>
      {defs && <div className="row small muted" style={{ marginTop: 8 }}>{defs.find((d) => d.name === sel)?.tools.map((t: any) => <Badge key={t.name} kind={t.requiresApproval ? "warn" : ""}>{t.name}{t.requiresApproval ? " · approval" : ""}</Badge>)}</div>}
      {defs?.length === 0 && <div className="muted small">No agents registered on this server. Register them in the server's agent registry; runs recorded through the SDK still appear below.</div>}</div>
    <div className="row" style={{ marginBottom: 8 }}><select value={agent} onChange={(e) => setAgent(e.target.value)}><option value="">all agents</option>{[...new Set((runs ?? []).map((r) => r.agentName))].map((a) => <option key={a}>{a}</option>)}</select>
      <select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">any status</option>{["running", "awaiting_approval", "completed", "failed", "killed"].map((s) => <option key={s}>{s}</option>)}</select><button className="sm" onClick={reload}>refresh</button></div>
    {runs && runs.length === 0 && <Empty>No runs yet.</Empty>}
    {runs && runs.length > 0 && <div className="card tight"><table><thead><tr><th>When</th><th>Agent</th><th>Status</th><th>Origin</th><th className="right">Events</th><th className="right">Cost</th><th className="right">Duration</th><th></th></tr></thead>
      <tbody>{runs.map((r) => <tr key={r.id} className="click" onClick={() => navigate(`/runs/${r.id}`)}><td className="muted nowrap">{fmt.ago(r.startedAt)}</td><td>{r.agentName}<div className="dim small mono">{r.id}</div></td><td><Badge kind={r.status}>{r.status}</Badge></td><td className="small">{r.parentRunId ? <>{r.metadata?.mode ?? "fork"} of <Link to={`/runs/${r.parentRunId}`} onClick={(e: any) => e.stopPropagation()}>{r.parentRunId.slice(-6)}</Link>{r.forkedAtSeq != null && ` @#${r.forkedAtSeq}`}</> : <span className="dim">live</span>}</td><td className="right">{r.eventCount}</td><td className="right mono">{fmt.usd(r.costUsd)}</td><td className="right">{r.endedAt ? fmt.ms(r.endedAt - r.startedAt) : "…"}</td>
        <td>{(r.status === "running" || r.status === "awaiting_approval") && <button className="sm danger" onClick={(e) => { e.stopPropagation(); confirmThen(`Kill run ${r.id}?`, () => api.post(`/api/runs/${r.id}/kill`, { reason: "killed from UI" }).then(reload)); }}>kill</button>}</td></tr>)}</tbody></table></div>}
  </>;
}

const EVENT_COLORS: Record<string, string> = { llm_response: "llm", tool_call: "tool", tool_result: "tool", approval_requested: "warn", approval_resolved: "warn", error: "error", run_finished: "ok", run_started: "ok" };

function RunDetail({ id }: { id: string }) {
  const { data, reload } = useFetch<any>(`/api/runs/${id}`, { deps: [id] });
  const [live, setLive] = useState<any[]>([]);
  const [sel, setSel] = useState<number | null>(null);
  const [tab, setTab] = useState<"timeline" | "trace" | "diff">("timeline");
  const [diffWith, setDiffWith] = useState("");
  const [diff, setDiff] = useState<any>(null);
  const [forkPatch, setForkPatch] = useState("");
  const [forkModel, setForkModel] = useState("");
  useEffect(() => { setLive([]); setSel(null); const off = sse(`/api/runs/${id}/stream`, (_, ev) => { if (ev?.seq !== undefined) setLive((l) => (l.some((x) => x.seq === ev.seq) ? l : [...l, ev])); if (ev?.type === "run_finished" || ev?.type === "error") setTimeout(reload, 200); }); return off; }, [id]);
  useEffect(() => { if (diffWith) api.get(`/api/runs/${id}/diff/${diffWith}`).then(setDiff).catch((e) => toast(e.message, true)); }, [diffWith]);
  const events = useMemo(() => { const m = new Map<number, any>(); for (const e of [...(data?.events ?? []), ...live]) m.set(e.seq, e); return [...m.values()].sort((a, b) => a.seq - b.seq); }, [data, live]);
  if (!data) return <div className="muted">Loading…</div>;
  const selected = events.find((e) => e.seq === sel) ?? null;
  const pending = data.approvals.find((a: any) => a.status === "pending");
  const act = async (fn: () => Promise<any>, msg: string) => { try { await fn(); toast(msg); reload(); } catch (e) { toast((e as Error).message, true); } };
  const fork = async (atSeq: number) => {
    let replaceEvent: any; if (forkPatch.trim()) { try { replaceEvent = { seq: atSeq, payload: JSON.parse(forkPatch) }; } catch { return toast("patch must be JSON", true); } }
    try { const r = await api.post(`/api/runs/${id}/fork`, { atSeq, replaceEvent, model: forkModel || undefined, live: data.registered }); toast(r.live ? "forked and resumed live" : "forked (event copy only: agent not registered)"); navigate(`/runs/${r.runId}`); } catch (e) { toast((e as Error).message, true); }
  };
  return <>
    <div className="head"><div><h1>{data.agentName} <span className="dim mono" style={{ fontSize: 13 }}>{data.id}</span></h1><div className="sub">{fmt.time(data.startedAt)}{data.parentRunId && <> · {data.metadata?.mode ?? "fork"} of <Link to={`/runs/${data.parentRunId}`}>{data.parentRunId}</Link>{data.forkedAtSeq != null && ` at #${data.forkedAtSeq}`}</>}</div></div>
      <div className="row"><Badge kind={data.status}>{data.status}</Badge><span className="muted small">{events.length} events · {fmt.usd(data.costUsd)}</span>
        {(data.status === "running" || data.status === "awaiting_approval") && <button className="danger" onClick={() => confirmThen("Kill this run?", () => api.post(`/api/runs/${id}/kill`, { reason: "killed from UI" }).then(reload))}>Kill</button>}
        {data.registered && <button onClick={() => act(() => api.post(`/api/runs/${id}/replay`).then((r) => navigate(`/runs/${r.runId}`)), "replaying")}>Replay</button>}
        <Link to="/agents" className="btn">← all runs</Link></div></div>
    {pending && <div className="card" style={{ borderColor: "#78350f", marginBottom: 14 }}><div className="row" style={{ justifyContent: "space-between" }}><div><strong style={{ color: "var(--warn)" }}>Approval needed:</strong> {pending.title}<Json value={pending.details} max={600} /></div>
      <div className="row"><button className="primary" onClick={() => act(() => api.post(`/api/approvals/${pending.id}/resolve`, { status: "approved" }), "approved")}>Approve</button><button className="danger" onClick={() => act(() => api.post(`/api/approvals/${pending.id}/resolve`, { status: "rejected", reason: "rejected from run view" }), "rejected")}>Reject</button></div></div></div>}
    {data.children.length > 0 && <div className="row small muted" style={{ marginBottom: 10 }}>children: {data.children.map((c: any) => <Link key={c.id} to={`/runs/${c.id}`}><Badge kind={c.status}>{c.metadata?.mode ?? "fork"} {c.forkedAtSeq != null ? `@#${c.forkedAtSeq}` : ""} · {c.status}</Badge></Link>)}</div>}
    <Tabs tabs={[["timeline", "Timeline"], ["trace", "Trace"], ["diff", "Diff"]]} value={tab} onChange={setTab} />
    {tab === "timeline" && <div className="split">
      <div className="timeline">{events.map((e) => <div key={e.seq} className={`ev ${sel === e.seq ? "sel" : ""}`} onClick={() => setSel(e.seq)}><span className="seq">#{e.seq}</span><span className="type"><Badge kind={EVENT_COLORS[e.type] ?? ""}>{e.type}</Badge>{e.payload?.replayed && <span className="dim small"> replayed</span>}</span><span className="body">{summarize(e)}</span><span className="dim small nowrap">{fmt.ago(e.ts)}</span></div>)}{events.length === 0 && <div className="muted">No events yet…</div>}</div>
      <div className="card" style={{ position: "sticky", top: 0 }}>
        {selected ? <>
          <h3>#{selected.seq} {selected.type}</h3>
          <KV rows={[["time", fmt.time(selected.ts)], ["span", selected.spanId ? <Link to={`/traces/${data.traceId}`} className="mono small">{selected.spanId}</Link> : "-"]]} />
          <h2 style={{ marginTop: 10 }}>Payload</h2><Json value={selected.payload} max={6000} />
          <div style={{ marginTop: 14, borderTop: "1px solid var(--line)", paddingTop: 12 }}><h2>Fork from here</h2>
            <div className="muted small" style={{ marginBottom: 6 }}>Events up to and including #{selected.seq} are replayed from the recording; everything after runs live{data.registered ? "" : " (agent not registered on this server, so only the event prefix is copied)"}.</div>
            {(selected.type === "tool_result" || selected.type === "llm_response") && <label>replace this event's payload (JSON, optional)<textarea value={forkPatch} onChange={(e) => setForkPatch(e.target.value)} placeholder={JSON.stringify(selected.payload).slice(0, 200)} style={{ minHeight: 70 }} /></label>}
            <div className="row" style={{ marginTop: 6 }}><label>model override<input value={forkModel} onChange={(e) => setForkModel(e.target.value)} placeholder="e.g. claude-sonnet-5-5" /></label><button className="primary" style={{ alignSelf: "end" }} onClick={() => fork(selected.seq)}>Fork at #{selected.seq}</button></div></div>
        </> : <div className="muted">Select an event to inspect it or fork from it.</div>}
      </div></div>}
    {tab === "trace" && (data.traceId ? <TraceDetail id={data.traceId} embedded /> : <Empty>No trace linked to this run.</Empty>)}
    {tab === "diff" && <div><div className="row" style={{ marginBottom: 10 }}><label>compare with run id<input value={diffWith} onChange={(e) => setDiffWith(e.target.value)} placeholder="run_…" style={{ width: 320 }} /></label>{data.children.map((c: any) => <button key={c.id} className="sm" style={{ alignSelf: "end" }} onClick={() => setDiffWith(c.id)}>child {c.id.slice(-6)}</button>)}{data.parentRunId && <button className="sm" style={{ alignSelf: "end" }} onClick={() => setDiffWith(data.parentRunId)}>parent</button>}</div>
      {diff && <><div className="grid g2" style={{ marginBottom: 12 }}>{[diff.a, diff.b].map((s: any, i) => <div key={i} className="card"><h2>{i === 0 ? "This run" : "Other run"}</h2><KV rows={[["run", <Link to={`/runs/${s.runId}`} className="mono small">{s.runId}</Link>], ["status", <Badge kind={s.status}>{s.status}</Badge>], ["events", s.events], ["cost", fmt.usd(s.costUsd)], ["output", <span className="small">{fmt.short(s.output ?? "", 300)}</span>]]} /></div>)}</div>
        <div className="card"><h2>Shared prefix: {diff.sharedPrefix} events · diverged at {diff.divergedAtSeq ?? "never"}</h2>{diff.changes.map((c: any) => <div key={c.seq} className="grid g2" style={{ marginBottom: 8 }}><div><div className="small muted">#{c.seq} {c.type} (this)</div><Json value={c.a ?? null} max={800} /></div><div><div className="small muted">#{c.seq} (other)</div><Json value={c.b ?? null} max={800} /></div></div>)}</div></>}</div>}
  </>;
}

function summarize(e: any): string {
  const p = e.payload ?? {};
  switch (e.type) {
    case "run_started": return `input: ${fmt.json(p.input, 200)}  model=${p.model}  tools=[${(p.tools ?? []).join(", ")}]`;
    case "llm_request": return `step ${p.step} · ${p.messageCount} messages → ${p.model}`;
    case "llm_response": { const c = p.message?.content; const txt = typeof c === "string" ? c : (c ?? []).map((x: any) => x.type === "text" ? x.text : x.type === "tool_use" ? `⚙ ${x.name}(${JSON.stringify(x.input)})` : "").join(" "); return `${fmt.short(txt, 300)}  · ${p.usage?.inputTokens ?? 0}/${p.usage?.outputTokens ?? 0} tok · ${fmt.usd(p.costUsd)}`; }
    case "tool_call": return `${p.name}(${fmt.json(p.input, 200)})`;
    case "tool_result": return `${p.isError ? "✗ " : ""}${fmt.short(String(p.content ?? ""), 300)}`;
    case "approval_requested": return `waiting for a human: ${p.name}(${fmt.json(p.input, 160)})`;
    case "approval_resolved": return `${p.status}${p.by ? ` by ${p.by}` : ""}${p.reason ? ` — ${p.reason}` : ""}`;
    case "state_snapshot": return `step ${p.step} · ${p.messageCount} messages · ${fmt.usd(p.costUsd)}`;
    case "run_finished": return `${fmt.short(p.output ?? "", 300)}  · ${p.steps} steps · ${fmt.usd(p.costUsd)}`;
    case "error": return p.message ?? p.reason ?? JSON.stringify(p);
    default: return fmt.json(p, 200);
  }
}
