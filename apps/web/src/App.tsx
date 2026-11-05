import { useEffect, useState } from "react";
import { Link, RouterProvider, match, useRoute } from "./lib/router";
import { api, setToken } from "./lib/api";
import { setProject, useProject } from "./lib/hooks";
import { Toaster } from "./components/ui";
import { Overview } from "./pages/Overview";
import { Traces } from "./pages/Traces";
import { Prompts } from "./pages/Prompts";
import { Datasets } from "./pages/Datasets";
import { Evals } from "./pages/Evals";
import { Agents } from "./pages/Agents";
import { GatewayPage } from "./pages/Gateway";
import { Knowledge } from "./pages/Knowledge";
import { Ops } from "./pages/Ops";

const NAV: Array<[string, string, string] | ["sec", string]> = [
  ["/", "Overview", "◫"],
  ["sec", "Build"], ["/prompts", "Prompts", "¶"], ["/datasets", "Datasets", "☷"], ["/evals", "Evals", "✓"], ["/knowledge", "Knowledge", "◈"],
  ["sec", "Observe"], ["/traces", "Traces", "⟋"], ["/agents", "Agents", "⚙"], ["/gateway", "Gateway", "⇄"],
  ["sec", "Operate"], ["/ops", "Approvals & Audit", "⚑"],
];

function Shell() {
  const { path } = useRoute();
  const project = useProject();
  const [projects, setProjects] = useState<Array<{ slug: string; name: string }>>([]);
  const [health, setHealth] = useState<{ ok: boolean; trusted: boolean; providers: string[] } | null>(null);
  const [authErr, setAuthErr] = useState(false);
  useEffect(() => {
    api.get("/api/health").then(setHealth).catch(() => setHealth(null));
    api.get("/api/projects").then(setProjects).catch((e) => { if (e.status === 401) setAuthErr(true); });
  }, []);
  const active = (to: string) => (to === "/" ? path === "/" : path.startsWith(to));
  let page: JSX.Element;
  if (path === "/") page = <Overview />;
  else if (match("/traces/:id", path) || path === "/traces") page = <Traces />;
  else if (path.startsWith("/prompts")) page = <Prompts />;
  else if (path.startsWith("/datasets")) page = <Datasets />;
  else if (path.startsWith("/evals")) page = <Evals />;
  else if (path.startsWith("/agents") || path.startsWith("/runs")) page = <Agents />;
  else if (path.startsWith("/gateway")) page = <GatewayPage />;
  else if (path.startsWith("/knowledge")) page = <Knowledge />;
  else if (path.startsWith("/ops")) page = <Ops />;
  else page = <div className="empty">Not found</div>;

  if (authErr) {
    return <div className="main" style={{ maxWidth: 420, margin: "80px auto" }}>
      <div className="card"><h3>Admin token required</h3><p className="muted">This server runs with CRUCIBLE_ADMIN_TOKEN set.</p>
        <form onSubmit={(e) => { e.preventDefault(); setToken(new FormData(e.currentTarget).get("t") as string); location.reload(); }} className="row">
          <input name="t" placeholder="token" type="password" style={{ flex: 1 }} /><button className="primary">Sign in</button></form></div></div>;
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand"><span className="logo">⚗</span>Crucible</div>
        <nav className="nav">
          {NAV.map((n, i) => n[0] === "sec" ? <div key={i} className="sec">{n[1]}</div> : <Link key={n[0]} to={n[0]} className={active(n[0]) ? "active" : ""}><span style={{ width: 14, textAlign: "center", color: "var(--fg-2)" }}>{n[2]}</span>{n[1]}</Link>)}
        </nav>
        <div style={{ marginTop: "auto", padding: "10px 8px", display: "grid", gap: 8 }}>
          <label>Project
            <select value={project} onChange={(e) => setProject(e.target.value)}>
              {(projects.length ? projects : [{ slug: project, name: project }]).map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
            </select></label>
          <div className="dim small">{health ? <>{health.trusted ? "local trusted mode" : "authenticated"} · {health.providers.join(", ")}</> : <span style={{ color: "var(--err)" }}>server unreachable</span>}</div>
        </div>
      </aside>
      <main className="main">{page}</main>
      <Toaster />
    </div>
  );
}

export default function App() { return <RouterProvider><Shell /></RouterProvider>; }
