import { useEffect, useState, type ReactNode } from "react";
import { fmt } from "../lib/api";

export function Badge({ kind, children }: { kind?: string; children: ReactNode }) {
  return <span className={`badge ${kind ?? ""}`}>{children}</span>;
}

export function Stat({ label, value, detail }: { label: string; value: ReactNode; detail?: ReactNode }) {
  return <div className="card stat"><div className="l">{label}</div><div className="v">{value}</div>{detail !== undefined && <div className="d">{detail}</div>}</div>;
}

export function Empty({ children }: { children: ReactNode }) { return <div className="empty">{children}</div>; }

export function Json({ value, max = 4000 }: { value: unknown; max?: number }) {
  const s = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return <pre>{s && s.length > max ? s.slice(0, max) + "\n…" : s}</pre>;
}

export function KV({ rows }: { rows: Array<[string, ReactNode]> }) {
  return <dl className="kv">{rows.map(([k, v]) => <><dt key={k + "k"}>{k}</dt><dd key={k + "v"}>{v}</dd></>)}</dl>;
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: Array<[T, string]>; value: T; onChange: (t: T) => void }) {
  return <div className="tabs">{tabs.map(([k, label]) => <button key={k} className={k === value ? "active" : ""} onClick={() => onChange(k)}>{label}</button>)}</div>;
}

let pushToast: ((t: { text: string; err?: boolean }) => void) | null = null;
export function toast(text: string, err = false) { pushToast?.({ text, err }); }
export function Toaster() {
  const [t, setT] = useState<{ text: string; err?: boolean } | null>(null);
  useEffect(() => { pushToast = (x) => { setT(x); setTimeout(() => setT(null), 3500); }; return () => { pushToast = null; }; }, []);
  return t ? <div className={`toast ${t.err ? "err" : ""}`}>{t.text}</div> : null;
}

export function Spark({ values }: { values: number[] }) {
  const max = Math.max(1, ...values);
  return <div className="spark">{values.map((v, i) => <i key={i} style={{ height: `${Math.max(4, (v / max) * 100)}%` }} />)}</div>;
}

export function Progress({ value, kind }: { value: number; kind?: "ok" | "err" }) {
  return <div className="bar"><i className={kind ?? ""} style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }} /></div>;
}

export function Money({ v }: { v: number | null | undefined }) { return <span className="mono">{fmt.usd(v)}</span>; }

/** Confirm wrapper for destructive buttons. */
export async function confirmThen(msg: string, fn: () => Promise<unknown>) {
  if (!confirm(msg)) return;
  try { await fn(); } catch (e) { toast((e as Error).message, true); }
}
