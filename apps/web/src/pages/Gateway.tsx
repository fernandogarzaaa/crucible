import { useEffect, useState } from "react";
import { api, fmt } from "../lib/api";
import { useFetch, useProject } from "../lib/hooks";
import { Badge, Empty, Json, Tabs, confirmThen, toast } from "../components/ui";

export function GatewayPage() {
  const project = useProject();
  const [tab, setTab] = useState<"requests" | "routes" | "cli" | "budgets" | "keys" | "playground">("requests");
  const { data: stats } = useFetch<any>(`/api/projects/${project}/gateway/stats`, { pollMs: 5000 });
  return <>
    <div className="head"><div><h1>Gateway</h1><div className="sub">One endpoint for every model. Point any OpenAI SDK at <code>/v1</code> or any Anthropic SDK at <code>/v1/messages</code>.</div></div>
      {stats && <div className="row muted small">{stats.requests} requests · {stats.cached} cached · {stats.errors} errors · {fmt.usd(stats.costUsd)} (24h)</div>}</div>
    <Tabs tabs={[["requests", "Requests"], ["routes", "Routes"], ["cli", "CLI providers"], ["budgets", "Budgets"], ["keys", "API keys"], ["playground", "Playground"]]} value={tab} onChange={setTab} />
    {tab === "requests" && <Requests project={project} byModel={stats?.byModel ?? []} />}
    {tab === "routes" && <Routes />}
    {tab === "cli" && <CliProviders />}
    {tab === "budgets" && <Budgets project={project} />}
    {tab === "keys" && <Keys project={project} />}
    {tab === "playground" && <Playground project={project} />}
  </>;
}

function Requests({ project, byModel }: { project: string; byModel: any[] }) {
  const { data } = useFetch<any[]>(`/api/projects/${project}/gateway/requests?limit=200`, { pollMs: 4000 });
  return <div className="grid" style={{ gridTemplateColumns: "1fr 320px" }}>
    <div className="card tight">{data && data.length === 0 && <Empty>No requests yet. Try the playground tab or:<pre style={{ textAlign: "left", marginTop: 10 }}>{`curl localhost:4800/v1/chat/completions \\\n  -H 'content-type: application/json' \\\n  -d '{"model":"smart","messages":[{"role":"user","content":"hi"}]}'`}</pre></Empty>}
      {data && data.length > 0 && <table><thead><tr><th>When</th><th>Route</th><th>Model</th><th>Provider</th><th>Status</th><th className="right">Latency</th><th className="right">Tokens</th><th className="right">Cost</th></tr></thead>
        <tbody>{data.map((r) => <tr key={r.id}><td className="muted nowrap">{fmt.ago(r.createdAt)}</td><td>{r.route}{r.fallbackDepth > 0 && <Badge kind="warn">fallback {r.fallbackDepth}</Badge>}</td><td className="mono small">{r.servedModel}{r.requestedModel !== r.servedModel && <div className="dim">asked: {r.requestedModel}</div>}</td><td>{r.provider}</td><td><Badge kind={r.status < 400 ? "ok" : "error"}>{r.status}</Badge>{r.cached && <Badge kind="ok">cached</Badge>}{r.error && <div className="dim small" style={{ maxWidth: 220 }}>{fmt.short(r.error, 100)}</div>}</td><td className="right">{fmt.ms(r.latencyMs)}</td><td className="right">{r.usage.inputTokens}/{r.usage.outputTokens}</td><td className="right mono">{fmt.usd(r.costUsd)}</td></tr>)}</tbody></table>}</div>
    <div className="card"><h2>By model (24h)</h2>{byModel.length === 0 ? <div className="muted small">—</div> : byModel.map((m) => <div key={m.model + m.provider} className="small" style={{ marginBottom: 8 }}><div className="row" style={{ justifyContent: "space-between" }}><span className="mono">{m.model}</span><span className="muted">{m.requests} · {fmt.usd(m.costUsd)}</span></div><div className="bar"><i style={{ width: `${(m.requests / Math.max(...byModel.map((x: any) => x.requests))) * 100}%` }} /></div></div>)}</div>
  </div>;
}

function Routes() {
  const { data, reload } = useFetch<any>("/api/gateway/models");
  const [text, setText] = useState("");
  useEffect(() => { if (data) setText(JSON.stringify({ routes: data.routes, defaultRoute: undefined }, null, 2)); }, [data]);
  const save = async () => { try { await api.put("/api/gateway/routes", JSON.parse(text)); toast("routes saved"); reload(); } catch (e) { toast((e as Error).message, true); } };
  if (!data) return null;
  return <div className="split">
    <div className="card"><h2>Routes</h2><div className="muted small" style={{ marginBottom: 8 }}>A route is a model alias clients send as <code>model</code>. Strategies: <code>fallback</code>, <code>round_robin</code>, <code>cheapest</code>, <code>weighted</code>. Per-route <code>cacheTtlSeconds</code> and <code>redact</code>.</div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} style={{ minHeight: 320 }} /><button className="primary" onClick={save} style={{ marginTop: 8 }}>Save routes</button></div>
    <div className="card"><h2>Providers</h2>{data.providers.map((p: any) => <div key={p.provider} style={{ marginBottom: 10 }}><strong>{p.provider}</strong><div className="pill-row" style={{ marginTop: 4 }}>{p.models.map((m: string) => <Badge key={m}>{m}</Badge>)}{p.models.length === 0 && <span className="dim small">any model id (pass-through)</span>}</div></div>)}
      <h2 style={{ marginTop: 14 }}>Pricing table (USD / 1M tokens)</h2><table><thead><tr><th>Model</th><th className="right">In</th><th className="right">Out</th></tr></thead><tbody>{data.pricing.map((p: any) => <tr key={p.model}><td className="mono small">{p.model}</td><td className="right">{p.input}</td><td className="right">{p.output}</td></tr>)}</tbody></table></div>
  </div>;
}

function Budgets({ project }: { project: string }) {
  const { data, reload } = useFetch<any[]>(`/api/projects/${project}/budgets`, { pollMs: 5000 });
  const [scope, setScope] = useState("project"); const [limit, setLimit] = useState("25"); const [period, setPeriod] = useState("monthly"); const [hard, setHard] = useState(true);
  return <div className="split">
    <div className="card"><h2>Set a budget</h2><div className="grid g2"><label>scope<input value={scope} onChange={(e) => setScope(e.target.value)} placeholder="project | key:<id> | agent:<name> | model:<id>" /></label><label>limit USD<input value={limit} onChange={(e) => setLimit(e.target.value)} /></label><label>period<select value={period} onChange={(e) => setPeriod(e.target.value)}><option>daily</option><option>weekly</option><option>monthly</option><option>total</option></select></label><label>hard stop<select value={hard ? "yes" : "no"} onChange={(e) => setHard(e.target.value === "yes")}><option value="yes">yes (block requests with 402)</option><option value="no">no (alert only)</option></select></label></div>
      <button className="primary" style={{ marginTop: 10 }} onClick={async () => { try { await api.post(`/api/projects/${project}/budgets`, { scope, limitUsd: Number(limit), period, hardStop: hard }); toast("budget saved"); reload(); } catch (e) { toast((e as Error).message, true); } }}>Save</button></div>
    <div className="card"><h2>Active budgets</h2>{data?.length === 0 && <div className="muted small">None.</div>}{data?.map((b) => <div key={b.id} style={{ marginBottom: 12 }}><div className="row" style={{ justifyContent: "space-between" }}><span><strong>{b.scope}</strong> <span className="muted">· {b.period} · {b.hardStop ? "hard stop" : "soft"}</span></span><span className="mono">{fmt.usd(b.spentUsd)} / {fmt.usd(b.limitUsd)}</span><button className="sm danger" onClick={() => confirmThen("Delete budget?", () => api.del(`/api/budgets/${b.id}`).then(reload))}>×</button></div><div className="bar" style={{ marginTop: 4 }}><i className={b.spentUsd >= b.limitUsd ? "err" : ""} style={{ width: `${Math.min(100, (b.spentUsd / b.limitUsd) * 100)}%` }} /></div></div>)}</div>
  </div>;
}

function Keys({ project }: { project: string }) {
  const { data, reload } = useFetch<any[]>(`/api/projects/${project}/keys`);
  const [name, setName] = useState(""); const [secret, setSecret] = useState<string | null>(null);
  return <div className="split">
    <div className="card"><h2>Create key</h2><div className="row"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="service name" /><button className="primary" disabled={!name} onClick={async () => { try { const k = await api.post(`/api/projects/${project}/keys`, { name }); setSecret(k.secret); setName(""); reload(); } catch (e) { toast((e as Error).message, true); } }}>Create</button></div>
      {secret && <div className="card" style={{ marginTop: 10, borderColor: "var(--accent)" }}><div className="small muted">Copy now; it is not shown again.</div><pre>{secret}</pre><div className="small muted">Use as <code>Authorization: Bearer …</code> or as the OpenAI/Anthropic SDK api key with base URL <code>{location.origin}/v1</code>.</div></div>}</div>
    <div className="card tight"><table><thead><tr><th>Name</th><th>Prefix</th><th>Scopes</th><th>Last used</th><th></th></tr></thead><tbody>{data?.map((k) => <tr key={k.id} style={{ opacity: k.revokedAt ? 0.5 : 1 }}><td>{k.name}</td><td className="mono small">{k.prefix}…</td><td className="pill-row">{k.scopes.map((s: string) => <Badge key={s}>{s}</Badge>)}</td><td className="muted">{k.revokedAt ? "revoked" : fmt.ago(k.lastUsedAt)}</td><td>{!k.revokedAt && <button className="sm danger" onClick={() => confirmThen(`Revoke ${k.name}?`, () => api.del(`/api/keys/${k.id}`).then(reload))}>revoke</button>}</td></tr>)}</tbody></table>{data?.length === 0 && <div className="muted small" style={{ padding: 10 }}>No keys. In trusted local mode none are needed.</div>}</div>
  </div>;
}

function Playground({ project }: { project: string }) {
  const { data: models } = useFetch<any>("/api/gateway/models");
  const [model, setModel] = useState("smart"); const [system, setSystem] = useState(""); const [user, setUser] = useState("Explain what a model gateway does in two sentences.");
  const [out, setOut] = useState<any>(null); const [busy, setBusy] = useState(false); const [compare, setCompare] = useState<string[]>([]);
  const options = models ? [...models.routes.map((r: any) => r.name), ...models.providers.flatMap((p: any) => p.models.map((m: string) => `${p.provider}/${m}`))] : ["smart", "fast"];
  const run = async () => {
    setBusy(true);
    const targets = compare.length ? [model, ...compare] : [model];
    try { const results = await Promise.all(targets.map((m) => api.post(`/api/projects/${project}/chat`, { messages: [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: user }], config: { model: m } }).catch((e: Error) => ({ error: e.message, model: m })))); setOut(results); } finally { setBusy(false); }
  };
  return <div className="split">
    <div className="card"><div className="grid g2"><label>model / route<select value={model} onChange={(e) => setModel(e.target.value)}>{options.map((m: string) => <option key={m}>{m}</option>)}</select></label><label>compare with<select multiple value={compare} onChange={(e) => setCompare([...e.target.selectedOptions].map((o) => o.value))} style={{ height: 70 }}>{options.filter((m: string) => m !== model).map((m: string) => <option key={m}>{m}</option>)}</select></label></div>
      <label style={{ marginTop: 8 }}>system<textarea value={system} onChange={(e) => setSystem(e.target.value)} style={{ minHeight: 60 }} /></label><label style={{ marginTop: 8 }}>user<textarea value={user} onChange={(e) => setUser(e.target.value)} /></label><button className="primary" disabled={busy} onClick={run} style={{ marginTop: 8 }}>{busy ? "Running…" : compare.length ? `Run ${compare.length + 1} side by side` : "Run"}</button></div>
    <div className="grid" style={{ gap: 10 }}>{out?.map((r: any, i: number) => <div key={i} className="card">{r.error ? <><Badge kind="error">{r.model}</Badge><div className="mono small" style={{ color: "var(--err)", marginTop: 6 }}>{r.error}</div></> : <><div className="row small muted"><Badge>{r.provider}</Badge><span className="mono">{r.model}</span> · {fmt.ms(r.latencyMs)} · {r.usage.inputTokens}/{r.usage.outputTokens} tok · {fmt.usd(r.costUsd)}{r.cached && <Badge kind="ok">cached</Badge>}</div><Json value={r.message.content} /></>}</div>)}{!out && <div className="card muted">Responses appear here. Select several models to compare them side by side.</div>}</div>
  </div>;
}

function CliProviders() {
  const { data, reload } = useFetch<any>("/api/gateway/cli");
  const [busy, setBusy] = useState(false);
  if (!data) return <div className="muted">Checking installed CLIs…</div>;
  const refresh = async () => { setBusy(true); try { await api.post("/api/gateway/free/refresh"); toast("free models rediscovered"); reload(); } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); } };
  const pin: Record<string, string> = { "claude-code": "claude-code/sonnet", codex: "codex/default", opencode: "opencode/opencode/<model>-free", cline: "cline/openrouter/<model>:free" };
  return <div className="grid" style={{ gap: 14 }}>
    <div className="card">
      <h2>Wrapped CLIs</h2>
      <div className="muted small" style={{ marginBottom: 10 }}>Crucible runs each vendor's own CLI as a subprocess, so requests use the login that CLI already holds. Credentials never pass through Crucible. Tool calling and images are not supported on these routes.</div>
      <table><thead><tr><th>CLI</th><th>Use</th><th>Installed</th><th>Signed in</th><th>Pin as</th><th>Detail</th></tr></thead>
        <tbody>{data.clis.map((c: any) => <tr key={c.name}>
          <td><strong>{c.name}</strong><div className="dim small">{c.version ?? ""}</div></td>
          <td>{c.purpose === "subscription" ? <Badge kind="llm">subscription</Badge> : <Badge kind="ok">free models</Badge>}</td>
          <td>{c.installed ? <Badge kind="ok">yes</Badge> : <Badge kind="error">no</Badge>}</td>
          <td>{c.loggedIn === null ? <Badge>unknown</Badge> : c.loggedIn ? <Badge kind="ok">yes</Badge> : <Badge kind="warn">no</Badge>}</td>
          <td className="mono small">{c.installed ? pin[c.name] : ""}</td>
          <td className="small muted" style={{ maxWidth: 360 }}>{c.detail}{c.installed && c.loggedIn === false && <div style={{ marginTop: 4 }}>Sign in from a terminal: <code>crucible cli login {c.name === "claude-code" ? "claude" : c.name}</code></div>}</td>
        </tr>)}</tbody></table>
    </div>
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}><h2 style={{ margin: 0 }}>Free route</h2><button className="sm" disabled={busy} onClick={refresh}>{busy ? "Discovering…" : "Rediscover free models"}</button></div>
      <div className="muted small" style={{ margin: "8px 0" }}>Send <code>model: "free"</code> to try these in order; a rate-limited model hands off to the next one.{!data.freeRouteAuto && " This route was saved by hand, so discovery does not change it."}</div>
      {data.freeRoute ? <ol className="small mono" style={{ margin: 0, paddingLeft: 20 }}>{data.freeRoute.targets.map((t: any, i: number) => <li key={i}>{t.provider}/{t.model}</li>)}</ol> : <Empty>No free targets. Install OpenCode (<code>npm i -g opencode-ai</code>) or set OPENROUTER_API_KEY and install Cline.</Empty>}
      {data.free && <div className="small dim" style={{ marginTop: 8 }}>Discovered {data.free.opencodeZen.length} OpenCode Zen and {data.free.openrouter.length} OpenRouter free models {fmt.ago(data.free.discoveredAt)}.{data.free.errors.length ? ` Errors: ${data.free.errors.join("; ")}` : ""}</div>}
    </div>
  </div>;
}
