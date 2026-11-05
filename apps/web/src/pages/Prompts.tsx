import { useEffect, useState } from "react";
import { api, fmt } from "../lib/api";
import { useFetch, useProject } from "../lib/hooks";
import { match, navigate, useRoute } from "../lib/router";
import { Badge, Empty, Json, toast } from "../components/ui";

export function Prompts() {
  const { path } = useRoute();
  const project = useProject();
  const name = match("/prompts/:name", path)?.name;
  const { data: prompts, reload } = useFetch<any[]>(`/api/projects/${project}/prompts`);
  const [creating, setCreating] = useState(false);
  return (
    <>
      <div className="head"><div><h1>Prompts</h1><div className="sub">Versioned templates with labels. Fetch them at runtime with <code>crucible.prompt("name@production")</code>.</div></div><button className="primary" onClick={() => setCreating(true)}>New prompt</button></div>
      {creating && <PromptEditor project={project} onDone={(n) => { setCreating(false); reload(); if (n) navigate(`/prompts/${n}`); }} />}
      <div className="split">
        <div className="card tight">
          {prompts && prompts.length === 0 && <Empty>No prompts yet.</Empty>}
          {prompts && prompts.length > 0 && <table><thead><tr><th>Name</th><th className="right">Versions</th><th className="right">Created</th></tr></thead><tbody>{prompts.map((p) => <tr key={p.id} className={`click ${p.name === name ? "sel" : ""}`} onClick={() => navigate(`/prompts/${p.name}`)}><td>{p.name}<div className="dim small">{p.description}</div></td><td className="right">{p.versionCount}</td><td className="right muted">{fmt.ago(p.createdAt)}</td></tr>)}</tbody></table>}
        </div>
        {name ? <PromptDetail project={project} name={name} onChange={reload} /> : <div className="card muted">Select a prompt.</div>}
      </div>
    </>
  );
}

function PromptDetail({ project, name, onChange }: { project: string; name: string; onChange: () => void }) {
  const { data, reload } = useFetch<any>(`/api/projects/${project}/prompts/${encodeURIComponent(name)}`, { deps: [name] });
  const [sel, setSel] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [playing, setPlaying] = useState(false);
  useEffect(() => { setSel(null); setEditing(false); }, [name]);
  if (!data) return <div className="card muted">Loading…</div>;
  const v = data.versions.find((x: any) => x.id === sel) ?? data.versions[0];
  const label = async (label: string) => { try { await api.post(`/api/prompt-versions/${v.id}/labels`, { label }); toast(`labelled v${v.version} as ${label}`); reload(); } catch (e) { toast((e as Error).message, true); } };
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}><h3 style={{ margin: 0 }}>{data.name}</h3><div className="row"><button className="sm" onClick={() => setPlaying(!playing)}>{playing ? "Close playground" : "Playground"}</button><button className="sm primary" onClick={() => setEditing(!editing)}>{editing ? "Cancel" : "New version"}</button></div></div>
      {editing && <PromptEditor project={project} existing={{ name: data.name, version: v }} onDone={() => { setEditing(false); reload(); onChange(); }} />}
      <div className="pill-row" style={{ margin: "10px 0" }}>{data.versions.map((x: any) => <button key={x.id} className={`sm ${x.id === v?.id ? "primary" : ""}`} onClick={() => setSel(x.id)}>v{x.version}{x.labels.length ? ` · ${x.labels.join(",")}` : ""}</button>)}</div>
      {v && <>
        <div className="row small muted" style={{ marginBottom: 8 }}><span className="mono">{v.id}</span> · {fmt.time(v.createdAt)} · model <code>{v.config.model}</code>{v.commitMessage && <> · “{v.commitMessage}”</>}</div>
        <div className="row" style={{ marginBottom: 10 }}>{v.labels.map((l: string) => <Badge key={l} kind="ok">{l}</Badge>)}<button className="sm" onClick={() => label("production")}>Promote to production</button><button className="sm" onClick={() => label("staging")}>Label staging</button>
          <button className="sm" onClick={() => { const l = prompt("label name"); if (l) label(l); }}>Custom label…</button></div>
        <div className="chat">{v.template.map((m: any, i: number) => <div key={i} className={`msg ${m.role}`}><div className="role">{m.role}</div><div className="mono small" style={{ whiteSpace: "pre-wrap" }}>{typeof m.content === "string" ? m.content : JSON.stringify(m.content, null, 2)}</div></div>)}</div>
        <div className="row small muted" style={{ marginTop: 8 }}>variables: {v.variables.length ? v.variables.map((x: string) => <code key={x}>{`{{${x}}}`}</code>) : "none"}</div>
        <details style={{ marginTop: 8 }}><summary className="small muted">model config</summary><Json value={v.config} /></details>
        {playing && <Playground project={project} version={v} />}
      </>}
    </div>
  );
}

function Playground({ project, version }: { project: string; version: any }) {
  const [vars, setVars] = useState<Record<string, string>>({});
  const [model, setModel] = useState(version.config.model);
  const [models, setModels] = useState<string[]>([]);
  const [out, setOut] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get("/api/gateway/models").then((m) => setModels([...m.routes.map((r: any) => r.name), ...m.providers.flatMap((p: any) => p.models.map((x: string) => `${p.provider}/${x}`))])).catch(() => undefined); }, []);
  const render = (s: string) => s.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (w, k) => vars[k] ?? w);
  const run = async () => {
    setBusy(true);
    try {
      const messages = version.template.map((m: any) => ({ ...m, content: typeof m.content === "string" ? render(m.content) : m.content }));
      setOut(await api.post(`/api/projects/${project}/chat`, { messages, config: { ...version.config, model } }));
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  return <div style={{ marginTop: 14, borderTop: "1px solid var(--line)", paddingTop: 12 }}><h2>Playground</h2>
    <div className="grid g2">{version.variables.map((k: string) => <label key={k}>{k}<input value={vars[k] ?? ""} onChange={(e) => setVars({ ...vars, [k]: e.target.value })} /></label>)}</div>
    <div className="row" style={{ marginTop: 10 }}><label>model<select value={model} onChange={(e) => setModel(e.target.value)}>{[model, ...models.filter((m) => m !== model)].map((m) => <option key={m}>{m}</option>)}</select></label><button className="primary" disabled={busy} onClick={run} style={{ alignSelf: "end" }}>{busy ? "Running…" : "Run"}</button></div>
    {out && <div style={{ marginTop: 10 }}><div className="row small muted"><Badge>{out.provider}</Badge> {out.model} · {fmt.ms(out.latencyMs)} · {out.usage.inputTokens}/{out.usage.outputTokens} tok · {fmt.usd(out.costUsd)} {out.cached && <Badge kind="ok">cached</Badge>}</div><Json value={out.message.content} /></div>}
  </div>;
}

function PromptEditor({ project, existing, onDone }: { project: string; existing?: { name: string; version: any }; onDone: (name?: string) => void }) {
  const [name, setName] = useState(existing?.name ?? "");
  const [model, setModel] = useState(existing?.version?.config.model ?? "smart");
  const [temp, setTemp] = useState(existing?.version?.config.temperature ?? "");
  const [msgs, setMsgs] = useState<Array<{ role: string; content: string }>>(existing?.version?.template.map((m: any) => ({ role: m.role, content: typeof m.content === "string" ? m.content : JSON.stringify(m.content) })) ?? [{ role: "system", content: "You are a helpful assistant." }, { role: "user", content: "{{input}}" }]);
  const [commit, setCommit] = useState("");
  const save = async () => {
    try {
      const config: any = { model }; if (temp !== "") config.temperature = Number(temp);
      if (existing) await api.post(`/api/projects/${project}/prompts/${encodeURIComponent(existing.name)}/versions`, { template: msgs, config, commitMessage: commit || undefined });
      else await api.post(`/api/projects/${project}/prompts`, { name, template: msgs, config });
      toast("saved"); onDone(existing?.name ?? name);
    } catch (e) { toast((e as Error).message, true); }
  };
  return <div className="card" style={{ marginBottom: 14, borderColor: "var(--accent)" }}>
    <div className="grid g3">{!existing && <label>name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="support-reply" /></label>}<label>model or route<input value={model} onChange={(e) => setModel(e.target.value)} /></label><label>temperature<input value={temp} onChange={(e) => setTemp(e.target.value)} placeholder="default" /></label>{existing && <label>commit message<input value={commit} onChange={(e) => setCommit(e.target.value)} /></label>}</div>
    <div className="chat" style={{ marginTop: 10 }}>{msgs.map((m, i) => <div key={i} className={`msg ${m.role}`}><div className="row" style={{ justifyContent: "space-between" }}><select value={m.role} onChange={(e) => setMsgs(msgs.map((x, j) => j === i ? { ...x, role: e.target.value } : x))}><option>system</option><option>user</option><option>assistant</option></select><button className="sm" onClick={() => setMsgs(msgs.filter((_, j) => j !== i))}>remove</button></div><textarea value={m.content} onChange={(e) => setMsgs(msgs.map((x, j) => j === i ? { ...x, content: e.target.value } : x))} /></div>)}</div>
    <div className="row" style={{ marginTop: 10 }}><button className="sm" onClick={() => setMsgs([...msgs, { role: "user", content: "" }])}>+ message</button><span style={{ flex: 1 }} /><button onClick={() => onDone()}>Cancel</button><button className="primary" onClick={save} disabled={!existing && !name}>Save {existing ? "new version" : "prompt"}</button></div>
  </div>;
}
