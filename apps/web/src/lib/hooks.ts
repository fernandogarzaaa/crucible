import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

/** Fetch JSON with manual refresh and optional polling. */
export function useFetch<T = any>(path: string | null, opts: { pollMs?: number; deps?: unknown[] } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!path);
  const alive = useRef(true);
  const load = useCallback(async () => {
    if (!path) return;
    try { const d = await api.get<T>(path); if (alive.current) { setData(d); setError(null); } }
    catch (e) { if (alive.current) setError((e as Error).message); }
    finally { if (alive.current) setLoading(false); }
  }, [path, ...(opts.deps ?? [])]);
  useEffect(() => {
    alive.current = true; setLoading(!!path); void load();
    const t = opts.pollMs ? setInterval(() => void load(), opts.pollMs) : null;
    return () => { alive.current = false; if (t) clearInterval(t); };
  }, [load, opts.pollMs]);
  return { data, error, loading, reload: load, setData };
}

export function useProject(): string {
  return localStorage.getItem("crucible.project") ?? "default";
}
export function setProject(slug: string) { localStorage.setItem("crucible.project", slug); location.reload(); }
