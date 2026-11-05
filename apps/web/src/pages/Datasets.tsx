import { useState } from "react";
import { api, fmt } from "../lib/api";
import { useFetch, useProject } from "../lib/hooks";
import { match, navigate, useRoute } from "../lib/router";
import { Empty, Json, toast } from "../components/ui";

export function Datasets() {
  const project = useProject();
  const { path } = useRoute();
  const id = match("/datasets/:id", path)?.id;
  const { data, reload } = useFetch<any[]>(`/api/projects/${project}/datasets`);
  const [creating, setCreating] = useState(false);
  return (
    <>
      <div className="head"><div><h1>Datasets</h1><div className="sub">Inputs with expected outputs. Evals run prompts and agents against them.</div></div><button className="primary" onClick={() => setCreating(true)}>New dataset</button></div>
      {creating && <Creator project={project} onDone={(d) => { setCreating(false); reload(); if (d) navigate(`/datasets/${d}`); }} />}
      <div className="split">
        <div className="card tight">{data && data.length === 0 && <Empty>No datasets yet.</Empty>}
          {data && data.length > 0 && <table><thead><tr><th>Name</th><th className="right">Items</th><th className="right">Created</th></tr></thead><tbody>{data.map((d) => <tr key={d.id} className={`click ${d.id === id ? "sel" : ""}`} onClick={() => navigate(`/datasets/${d.id}`)}><td>{d.name}<div className="dim small">{d.description}</div></td><td className="right">{d.itemCount}</td><td className="right muted">{fmt.ago(d.createdAt)}</td></tr>)}</tbody></table>}</div>
        {id ? <Items id={id} onChange={reload} /> : <div className="card muted">Select a dataset.</div>}
      </div>
    </>
  );
}

function Items({ id, onChange }: { id: string; onChange: () => void }) {
  const { data, reload } = useFetch<any[]>(`/api/datasets/${id}/items`, { deps: [id] });
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState('[{"input": {"question": "..."}, "expected": "..."}]');
  const add = async () => {
    try { const items = text.trim().startsWith("[") ? JSON.parse(text) : text.split("\n").filter(Boolean).map((l) => JSON.parse(l)); await api.post(`/api/datasets/${id}/items`, items); toast(`added ${items.length}`); setAdding(false); reload(); onChange(); }
    catch (e) { toast((e as Error).message, true); }
  };
  if (!data) return <div className="card muted">Loading…</div>;
  return <div className="card">
    <div className="row" style={{ justifyContent: "space-between" }}><h3 style={{ margin: 0 }}>{data.length} items</h3><button className="sm primary" onClick={() => setAdding(!adding)}>Add items</button></div>
    {adding && <div style={{ margin: "10px 0" }}><textarea value={text} onChange={(e) => setText(e.target.value)} style={{ minHeight: 120 }} /><div className="row small muted">JSON array or JSONL with <code>input</code>, optional <code>expected</code> and <code>metadata</code></div><button className="primary sm" onClick={add} style={{ marginTop: 6 }}>Import</button></div>}
    <table style={{ marginTop: 10 }}><thead><tr><th>Input</th><th>Expected</th><th></th></tr></thead><tbody>{data.map((it) => <tr key={it.id}><td><Json value={it.input} max={600} /></td><td><Json value={it.expected ?? null} max={400} /></td><td><button className="sm danger" onClick={async () => { await api.del(`/api/dataset-items/${it.id}`); reload(); onChange(); }}>×</button></td></tr>)}</tbody></table>
  </div>;
}

function Creator({ project, onDone }: { project: string; onDone: (id?: string) => void }) {
  const [name, setName] = useState(""); const [desc, setDesc] = useState("");
  return <div className="card" style={{ marginBottom: 14, borderColor: "var(--accent)" }}><div className="row"><label>name<input value={name} onChange={(e) => setName(e.target.value)} /></label><label>description<input value={desc} onChange={(e) => setDesc(e.target.value)} style={{ width: 320 }} /></label><button className="primary" style={{ alignSelf: "end" }} disabled={!name} onClick={async () => { try { const d = await api.post(`/api/projects/${project}/datasets`, { name, description: desc || undefined }); onDone(d.id); } catch (e) { toast((e as Error).message, true); } }}>Create</button><button style={{ alignSelf: "end" }} onClick={() => onDone()}>Cancel</button></div></div>;
}
