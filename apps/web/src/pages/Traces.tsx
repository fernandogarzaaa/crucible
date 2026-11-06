import { useMemo, useState } from "react";
import { useFetch, useProject } from "../lib/hooks";
import { fmt } from "../lib/api";
import { Link, match, navigate, useRoute } from "../lib/router";
import { Badge, Empty, Json, KV } from "../components/ui";

export function Traces() {
  const { path, query } = useRoute();
  const id = match("/traces/:id", path)?.id;
  return id ? <TraceDetail id={id} /> : <TraceList initialSearch={query.get("q") ?? ""} />;
}

function TraceList({ initialSearch }: { initialSearch: string }) {
  const project = useProject();
  const [search, setSearch] = useState(initialSearch);
  const [status, setStatus] = useState("");
  const [tag, setTag] = useState("");
  const q = new URLSearchParams({ limit: "100", ...(search ? { search } : {}), ...(status ? { status } : {}), ...(tag ? { tag } : {}) });
  const { data, error } = useFetch<any[]>(`/api/projects/${project}/traces?${q}`, { pollMs: 4000 });
  return (
    <>
      <div className="head"><div><h1>Traces</h1><div className="sub">Every LLM call, tool call and retrieval, grouped per request.</div></div>
        <div className="row"><input placeholder="search name / input / output" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 260 }} />
          <select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">any status</option><option value="ok">ok</option><option value="error">error</option><option value="running">running</option></select>
          <select value={tag} onChange={(e) => setTag(e.target.value)}><option value="">any tag</option><option value="agent">agent</option><option value="eval">eval</option><option value="rag">rag</option></select></div></div>
      {error && <Empty>{error}</Empty>}
      {data && data.length === 0 && <Empty>No traces match. Send some with the SDK or the gateway.</Empty>}
      {data && data.length > 0 && <div className="card tight"><table><thead><tr><th>When</th><th>Name</th><th>Status</th><th>Tags</th><th className="right">Spans</th><th className="right">Tokens</th><th className="right">Cost</th><th className="right">Duration</th></tr></thead>
        <tbody>{data.map((t) => <tr key={t.id} className="click" onClick={() => navigate(`/traces/${t.id}`)}><td className="nowrap muted">{fmt.ago(t.startedAt)}</td><td>{t.name}<div className="dim small">{fmt.json(t.input, 90)}</div></td><td><Badge kind={t.status}>{t.status}</Badge></td><td className="pill-row">{t.tags.map((x: string) => <Badge key={x}>{x}</Badge>)}</td><td className="right">{t.spanCount}</td><td className="right">{fmt.num(t.totalTokens)}</td><td className="right mono">{fmt.usd(t.costUsd)}</td><td className="right">{t.endedAt ? fmt.ms(t.endedAt - t.startedAt) : "…"}</td></tr>)}</tbody></table></div>}
    </>
  );
}

export function TraceDetail({ id, embedded }: { id: string; embedded?: boolean }) {
  const { data, error } = useFetch<any>(`/api/traces/${id}`, { pollMs: 3000 });
  const [sel, setSel] = useState<string | null>(null);
  const tree = useMemo(() => {
    if (!data) return [];
    const spans: any[] = data.spans;
    const byParent = new Map<string | null, any[]>();
    for (const s of spans) { const k = s.parentSpanId && spans.some((x) => x.id === s.parentSpanId) ? s.parentSpanId : null; (byParent.get(k) ?? byParent.set(k, []).get(k)!).push(s); }
    const out: Array<{ span: any; depth: number }> = [];
    const walk = (p: string | null, d: number) => { for (const s of byParent.get(p) ?? []) { out.push({ span: s, depth: d }); walk(s.id, d + 1); } };
    walk(null, 0);
    return out;
  }, [data]);
  if (error) return <Empty>{error}</Empty>;
  if (!data) return <div className="muted">Loading…</div>;
  const t0 = data.startedAt, t1 = Math.max(data.endedAt ?? Date.now(), ...data.spans.map((s: any) => s.endedAt ?? Date.now()));
  const total = Math.max(1, t1 - t0);
  const selected = data.spans.find((s: any) => s.id === sel) ?? data.spans[0];
  return (
    <>
      {!embedded && <div className="head"><div><h1>{data.name}</h1><div className="sub mono small">{data.id} · {fmt.time(data.startedAt)}</div></div>
        <div className="row"><Badge kind={data.status}>{data.status}</Badge><span className="muted">{data.spanCount} spans · {fmt.num(data.totalTokens)} tokens · {fmt.usd(data.costUsd)} · {data.endedAt ? fmt.ms(data.endedAt - data.startedAt) : "running"}</span><Link to="/traces" className="btn">← all traces</Link></div></div>}
      <div className="split">
        <div className="card">
          <h2>Waterfall</h2>
          <div className="waterfall">
            {tree.map(({ span, depth }) => {
              const left = ((span.startedAt - t0) / total) * 100, width = Math.max(0.6, (((span.endedAt ?? Date.now()) - span.startedAt) / total) * 100);
              return <div key={span.id} className={`wf-row ${selected?.id === span.id ? "sel" : ""}`} onClick={() => setSel(span.id)}>
                <div className="nowrap" style={{ paddingLeft: depth * 14, overflow: "hidden", textOverflow: "ellipsis" }}><Badge kind={span.kind}>{span.kind}</Badge> <span className="small">{span.name}</span></div>
                <div className="wf-bar"><i className={span.status === "error" ? "error" : span.kind} style={{ left: `${left}%`, width: `${width}%` }} /></div>
                <div className="right small muted nowrap">{span.endedAt ? fmt.ms(span.endedAt - span.startedAt) : "…"}{span.costUsd ? ` · ${fmt.usd(span.costUsd)}` : ""}</div></div>;
            })}
            {tree.length === 0 && <div className="muted small">No spans.</div>}
          </div>
          {data.metadata && Object.keys(data.metadata).length > 0 && <div style={{ marginTop: 14 }}><h2>Metadata</h2><Json value={data.metadata} /></div>}
        </div>
        <div className="card">
          {selected ? <>
            <div className="row" style={{ justifyContent: "space-between" }}><h3 style={{ margin: 0 }}><Badge kind={selected.kind}>{selected.kind}</Badge> {selected.name}</h3><Badge kind={selected.status}>{selected.status}</Badge></div>
            <div style={{ margin: "10px 0" }}><KV rows={[["span", <span className="mono small">{selected.id}</span>], ["model", selected.model ?? "-"], ["duration", selected.endedAt ? fmt.ms(selected.endedAt - selected.startedAt) : "running"], ["usage", selected.usage ? `${selected.usage.inputTokens} in / ${selected.usage.outputTokens} out${selected.usage.cacheReadTokens ? ` / ${selected.usage.cacheReadTokens} cached` : ""}` : "-"], ["cost", fmt.usd(selected.costUsd)]]} /></div>
            {selected.error && <div className="card" style={{ borderColor: "#7f1d1d", marginBottom: 10 }}><strong style={{ color: "var(--err)" }}>Error</strong><div className="mono small">{selected.error}</div></div>}
            <h2>Input</h2><Json value={selected.input ?? null} />
            <h2 style={{ marginTop: 12 }}>Output</h2><Json value={selected.output ?? null} />
            {Object.keys(selected.attributes ?? {}).length > 0 && <><h2 style={{ marginTop: 12 }}>Attributes</h2><Json value={selected.attributes} /></>}
          </> : <><h2>Trace input</h2><Json value={data.input ?? null} /><h2 style={{ marginTop: 12 }}>Trace output</h2><Json value={data.output ?? null} /></>}
        </div>
      </div>
    </>
  );
}
