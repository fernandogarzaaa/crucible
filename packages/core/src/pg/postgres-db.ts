import { existsSync } from "node:fs";
import type { Db, Dialect, Row, SqlValue } from "../db.js";
import { SyncBridge } from "./bridge.js";
import { POSTGRES_MIGRATIONS } from "./schema.js";

/** Translate the SQLite-flavoured SQL the repositories use into Postgres. */
export function toPostgresSql(sql: string): string {
  let i = 0;
  return sql
    .replace(/\?/g, () => `$${++i}`)
    .replace(/\bPRAGMA\b[^;]*;?/g, "");
}

export class PostgresDb implements Db {
  readonly dialect: Dialect = "postgres";
  private readonly bridge: SyncBridge;
  private txDepth = 0;

  /** @param url postgres://user:pass@host/db, pglite://memory, or pglite://path/to/dir */
  constructor(url: string) {
    const here = new URL(import.meta.url);
    const workerUrl = new URL(here.pathname.endsWith(".ts") ? "./worker.ts" : "./worker.js", here);
    if (!existsSync(workerUrl)) throw new Error(`database worker not found at ${workerUrl.pathname}; run the build`);
    this.bridge = new SyncBridge(workerUrl, { url });
    this.migrate();
  }

  private exec(sql: string): void {
    this.bridge.call("exec", [sql, []]);
  }

  private migrate(): void {
    this.exec("CREATE TABLE IF NOT EXISTS _migrations (version BIGINT PRIMARY KEY, applied_at BIGINT NOT NULL)");
    const applied = new Set(this.all<{ version: number }>("SELECT version FROM _migrations").map((r) => Number(r.version)));
    POSTGRES_MIGRATIONS.forEach((sql, i) => {
      const version = i + 1;
      if (applied.has(version)) return;
      this.transaction(() => {
        // Postgres cannot take CREATE TABLE IF NOT EXISTS _migrations twice inside one multi-statement exec with pg's simple query when mixed; run statements one at a time.
        for (const stmt of sql.split(/;\s*(?=\n|$)/).map((x) => x.trim()).filter(Boolean)) this.exec(stmt);
        this.run("INSERT INTO _migrations (version, applied_at) VALUES (?, ?)", version, Date.now());
      });
    });
  }

  run(sql: string, ...params: SqlValue[]): { changes: number | bigint } {
    const r = this.bridge.call<{ rowCount: number }>("exec", [toPostgresSql(sql), params]);
    return { changes: r.rowCount };
  }
  get<T = Row>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.bridge.call<{ rows: T[] }>("query", [toPostgresSql(sql), params]).rows[0];
  }
  all<T = Row>(sql: string, ...params: SqlValue[]): T[] {
    return this.bridge.call<{ rows: T[] }>("query", [toPostgresSql(sql), params]).rows;
  }
  transaction<T>(fn: () => T): T {
    const depth = this.txDepth++;
    const sp = `sp_${depth}`;
    this.exec(depth === 0 ? "BEGIN" : `SAVEPOINT ${sp}`);
    try {
      const out = fn();
      this.exec(depth === 0 ? "COMMIT" : `RELEASE SAVEPOINT ${sp}`);
      return out;
    } catch (err) {
      this.exec(depth === 0 ? "ROLLBACK" : `ROLLBACK TO SAVEPOINT ${sp}`);
      if (depth !== 0) this.exec(`RELEASE SAVEPOINT ${sp}`);
      throw err;
    } finally {
      this.txDepth--;
    }
  }
  close(): void {
    this.bridge.close();
  }
}
