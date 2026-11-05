import React, { createContext, useContext, useEffect, useState, type ReactNode } from "react";

interface RouteState { path: string; params: Record<string, string>; query: URLSearchParams }
const Ctx = createContext<RouteState>({ path: "/", params: {}, query: new URLSearchParams() });

function parse(): RouteState {
  const hash = location.hash.replace(/^#/, "") || "/";
  const [path, q] = hash.split("?") as [string, string | undefined];
  return { path, params: {}, query: new URLSearchParams(q ?? "") };
}

export function RouterProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(parse);
  useEffect(() => { const h = () => setState(parse()); addEventListener("hashchange", h); return () => removeEventListener("hashchange", h); }, []);
  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

export function useRoute() { return useContext(Ctx); }
export function navigate(to: string) { location.hash = to; }

/** Match "/runs/:id" style patterns. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split("/").filter(Boolean), b = path.split("/").filter(Boolean);
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    const seg = a[i]!;
    if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(b[i]!);
    else if (seg !== b[i]) return null;
  }
  return params;
}

export function Link({ to, children, className, title, onClick }: { to: string; children: ReactNode; className?: string; title?: string; onClick?: (e: React.MouseEvent) => void }) {
  return <a href={`#${to}`} className={className} title={title} onClick={onClick}>{children}</a>;
}
