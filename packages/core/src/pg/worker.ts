import { parentPort, workerData } from "node:worker_threads";
import type { MessagePort } from "node:worker_threads";

/**
 * Database worker. Owns a single connection so BEGIN/COMMIT/SAVEPOINT issued by the main thread apply
 * to one session. Supports two drivers selected by the connection string:
 *   postgres://… | postgresql://…   node-postgres (pg)
 *   pglite://memory | pglite:///abs/dir | pglite://relative/dir   PGlite (Postgres compiled to WASM, in-process)
 */
interface Init { url: string }
interface Driver { query(sql: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number }>; close(): Promise<void> }

const { port, sab, init } = workerData as { port: MessagePort; sab: SharedArrayBuffer; init: Init };
const flag = new Int32Array(sab);

async function connect(url: string): Promise<Driver> {
  if (url.startsWith("pglite://")) {
    const { PGlite } = await import("@electric-sql/pglite");
    const target = url.slice("pglite://".length);
    const db = target === "memory" || target === "" ? new PGlite() : new PGlite(target);
    await db.waitReady;
    return {
      async query(sql, params) { const r = await db.query(sql, params as never[]); return { rows: r.rows as Record<string, unknown>[], rowCount: r.affectedRows ?? r.rows.length }; },
      async close() { await db.close(); },
    };
  }
  const pg = await import("pg");
  // Return int8/numeric as strings (default) — the core layer normalizes with Number(); keep float8 as number.
  const client = new pg.default.Client({ connectionString: url });
  await client.connect();
  return {
    async query(sql, params) { const r = await client.query(sql, params); return { rows: r.rows as Record<string, unknown>[], rowCount: r.rowCount ?? 0 }; },
    async close() { await client.end(); },
  };
}

const toParam = (v: unknown) => (v instanceof Uint8Array && !Buffer.isBuffer(v) ? Buffer.from(v) : v);
const fromRow = (row: Record<string, unknown>) => { for (const k of Object.keys(row)) { const v = row[k]; if (typeof v === "bigint") row[k] = Number(v); } return row; };

let driver: Driver | undefined;
let initError: string | undefined;
const ready = connect(init.url).then((d) => { driver = d; }).catch((e: Error) => { initError = e.message; });

const queue: Array<{ method: string; args: unknown[] }> = [];
let busy = false;

async function handle(method: string, args: unknown[]): Promise<unknown> {
  await ready;
  if (method === "__ready") { if (initError) throw new Error(`database connect failed: ${initError}`); return true; }
  if (!driver) throw new Error(`database not connected: ${initError ?? "unknown"}`);
  if (method === "__close") { await driver.close(); return true; }
  const [sql, params] = args as [string, unknown[]];
  const r = await driver.query(sql, (params ?? []).map(toParam));
  if (method === "exec") return { rowCount: r.rowCount };
  return { rows: r.rows.map(fromRow), rowCount: r.rowCount };
}

async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const { method, args } = queue.shift()!;
    let message: { result?: unknown; error?: string };
    try { message = { result: await handle(method, args) }; } catch (e) { message = { error: (e as Error).message ?? String(e) }; }
    port.postMessage(message);
    Atomics.store(flag, 0, 1);
    Atomics.notify(flag, 0);
  }
  busy = false;
}

parentPort!.on("message", (m: { method: string; args: unknown[] }) => { queue.push(m); void pump(); });
