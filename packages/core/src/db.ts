import "./suppress-warning.js";
import { createRequire } from "node:module";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

// node:sqlite is loaded lazily via require so the experimental-warning filter above is installed first
// (ESM builtins are otherwise linked, and warn, before any user code runs).
const require = createRequire(import.meta.url);
const { DatabaseSync: SqliteDatabase } = require("node:sqlite") as typeof import("node:sqlite");
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type SqlValue = SQLInputValue;
export type Row = Record<string, SqlValue>;

export const SQLITE_MIGRATIONS: string[] = [
  // 001: foundation
  `
  CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);

  CREATE TABLE projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL
  );

  CREATE TABLE prompts (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL, description TEXT, created_at INTEGER NOT NULL, UNIQUE(project_id, name)
  );
  CREATE TABLE prompt_versions (
    id TEXT PRIMARY KEY, prompt_id TEXT NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
    version INTEGER NOT NULL, template TEXT NOT NULL, config TEXT NOT NULL, variables TEXT NOT NULL,
    commit_message TEXT, labels TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, UNIQUE(prompt_id, version)
  );

  CREATE TABLE datasets (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL, description TEXT, created_at INTEGER NOT NULL, UNIQUE(project_id, name)
  );
  CREATE TABLE dataset_items (
    id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
    input TEXT NOT NULL, expected TEXT, metadata TEXT, created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_dataset_items_ds ON dataset_items(dataset_id);

  CREATE TABLE traces (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL, status TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER,
    input TEXT, output TEXT, metadata TEXT NOT NULL DEFAULT '{}', tags TEXT NOT NULL DEFAULT '[]',
    session_id TEXT, user_id TEXT, total_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0, span_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_traces_project_time ON traces(project_id, started_at DESC);
  CREATE INDEX idx_traces_session ON traces(session_id);

  CREATE TABLE spans (
    id TEXT PRIMARY KEY, trace_id TEXT NOT NULL REFERENCES traces(id) ON DELETE CASCADE,
    parent_span_id TEXT, name TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
    started_at INTEGER NOT NULL, ended_at INTEGER, input TEXT, output TEXT,
    attributes TEXT NOT NULL DEFAULT '{}', model TEXT, provider TEXT, usage TEXT, cost_usd REAL, error TEXT
  );
  CREATE INDEX idx_spans_trace ON spans(trace_id, started_at);

  CREATE TABLE evals (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL, dataset_id TEXT NOT NULL, prompt_version_id TEXT, target TEXT,
    scorers TEXT NOT NULL, status TEXT NOT NULL, started_at INTEGER, ended_at INTEGER,
    summary TEXT NOT NULL DEFAULT '{}', baseline_eval_id TEXT, created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_evals_project ON evals(project_id, created_at DESC);
  CREATE TABLE eval_results (
    id TEXT PRIMARY KEY, eval_id TEXT NOT NULL REFERENCES evals(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL, output TEXT, scores TEXT NOT NULL, latency_ms REAL NOT NULL,
    cost_usd REAL NOT NULL, trace_id TEXT, error TEXT, created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_eval_results_eval ON eval_results(eval_id);

  CREATE TABLE agent_runs (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    agent_name TEXT NOT NULL, status TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER,
    parent_run_id TEXT, forked_at_seq INTEGER, trace_id TEXT, metadata TEXT NOT NULL DEFAULT '{}',
    cost_usd REAL NOT NULL DEFAULT 0, event_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_agent_runs_project ON agent_runs(project_id, started_at DESC);
  CREATE INDEX idx_agent_runs_status ON agent_runs(status);
  CREATE TABLE agent_events (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, span_id TEXT, ts INTEGER NOT NULL,
    UNIQUE(run_id, seq)
  );

  CREATE TABLE gateway_requests (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, api_key_id TEXT, requested_model TEXT NOT NULL,
    served_model TEXT NOT NULL, provider TEXT NOT NULL, route TEXT NOT NULL, status INTEGER NOT NULL,
    cached INTEGER NOT NULL DEFAULT 0, fallback_depth INTEGER NOT NULL DEFAULT 0, latency_ms REAL NOT NULL,
    usage TEXT NOT NULL, cost_usd REAL NOT NULL, trace_id TEXT, error TEXT, created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_gw_project_time ON gateway_requests(project_id, created_at DESC);

  CREATE TABLE budgets (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, scope TEXT NOT NULL, limit_usd REAL NOT NULL,
    period TEXT NOT NULL, hard_stop INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL,
    UNIQUE(project_id, scope, period)
  );

  CREATE TABLE api_keys (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, prefix TEXT NOT NULL,
    hash TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL, created_at INTEGER NOT NULL,
    last_used_at INTEGER, revoked_at INTEGER
  );

  CREATE TABLE knowledge_bases (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL, embedding_model TEXT NOT NULL, chunk_size INTEGER NOT NULL,
    chunk_overlap INTEGER NOT NULL, created_at INTEGER NOT NULL, UNIQUE(project_id, name)
  );
  CREATE TABLE documents (
    id TEXT PRIMARY KEY, knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    source TEXT NOT NULL, title TEXT NOT NULL, content_hash TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}',
    chunk_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
  );
  CREATE TABLE chunks (
    id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    knowledge_base_id TEXT NOT NULL, idx INTEGER NOT NULL, text TEXT NOT NULL,
    embedding BLOB, metadata TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX idx_chunks_kb ON chunks(knowledge_base_id);
  CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, chunk_id UNINDEXED, knowledge_base_id UNINDEXED);

  CREATE TABLE approvals (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, run_id TEXT NOT NULL, event_seq INTEGER NOT NULL,
    title TEXT NOT NULL, details TEXT, status TEXT NOT NULL, requested_at INTEGER NOT NULL,
    resolved_at INTEGER, resolved_by TEXT, reason TEXT
  );
  CREATE INDEX idx_approvals_status ON approvals(project_id, status);

  CREATE TABLE audit_log (
    id TEXT PRIMARY KEY, project_id TEXT, actor TEXT NOT NULL, action TEXT NOT NULL,
    target_type TEXT NOT NULL, target_id TEXT NOT NULL, details TEXT NOT NULL DEFAULT '{}', ts INTEGER NOT NULL
  );
  CREATE INDEX idx_audit_time ON audit_log(ts DESC);

  CREATE TABLE alert_rules (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, metric TEXT NOT NULL, op TEXT NOT NULL,
    threshold REAL NOT NULL, window_minutes INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    last_fired_at INTEGER, created_at INTEGER NOT NULL
  );

  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
  `,
];

export type Dialect = "sqlite" | "postgres";

/**
 * The synchronous SQL surface every repository is written against. Two implementations:
 * `SqliteDb` (embedded, default) and `PostgresDb` (team/enterprise tier, see ./pg/postgres-db.ts).
 */
export interface Db {
  readonly dialect: Dialect;
  run(sql: string, ...params: SqlValue[]): { changes: number | bigint };
  get<T = Row>(sql: string, ...params: SqlValue[]): T | undefined;
  all<T = Row>(sql: string, ...params: SqlValue[]): T[];
  transaction<T>(fn: () => T): T;
  close(): void;
}

export interface DbOptions {
  /** File path or ":memory:". */
  path: string;
}

export class SqliteDb implements Db {
  readonly dialect: Dialect = "sqlite";
  readonly raw: DatabaseSync;

  constructor(opts: DbOptions) {
    if (opts.path !== ":memory:") mkdirSync(dirname(opts.path), { recursive: true });
    this.raw = new SqliteDatabase(opts.path);
    this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;");
    this.migrate();
  }

  private migrate(): void {
    this.raw.exec("CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
    const applied = new Set(
      (this.raw.prepare("SELECT version FROM _migrations").all() as Array<{ version: number }>).map((r) => r.version),
    );
    SQLITE_MIGRATIONS.forEach((sql, i) => {
      const version = i + 1;
      if (applied.has(version)) return;
      this.transaction(() => {
        this.raw.exec(sql);
        this.raw.prepare("INSERT INTO _migrations (version, applied_at) VALUES (?, ?)").run(version, Date.now());
      });
    });
  }

  run(sql: string, ...params: SqlValue[]): { changes: number | bigint } {
    return this.raw.prepare(sql).run(...params);
  }

  get<T = Row>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: SqlValue[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  private txDepth = 0;

  /** Re-entrant transaction: the outermost call uses BEGIN/COMMIT, nested calls use SAVEPOINTs. */
  transaction<T>(fn: () => T): T {
    const depth = this.txDepth++;
    const sp = `sp_${depth}`;
    this.raw.exec(depth === 0 ? "BEGIN" : `SAVEPOINT ${sp}`);
    try {
      const out = fn();
      this.raw.exec(depth === 0 ? "COMMIT" : `RELEASE SAVEPOINT ${sp}`);
      return out;
    } catch (err) {
      this.raw.exec(depth === 0 ? "ROLLBACK" : `ROLLBACK TO SAVEPOINT ${sp}; RELEASE SAVEPOINT ${sp}`);
      throw err;
    } finally {
      this.txDepth--;
    }
  }

  close(): void {
    this.raw.close();
  }
}

// ---------- (de)serialization helpers ----------

export const j = {
  enc: (v: unknown): string | null => (v === undefined ? null : JSON.stringify(v)),
  dec: <T = unknown>(v: SqlValue | undefined, fallback: T): T => {
    if (v === null || v === undefined) return fallback;
    try {
      return JSON.parse(String(v)) as T;
    } catch {
      return fallback;
    }
  },
};
export const bool = {
  enc: (v: boolean | undefined): number => (v ? 1 : 0),
  dec: (v: SqlValue | undefined): boolean => Number(v) === 1,
};
export const num = (v: SqlValue | undefined): number => (v === null || v === undefined ? 0 : Number(v));
export const numOrNull = (v: SqlValue | undefined): number | null => (v === null || v === undefined ? null : Number(v));
export const str = (v: SqlValue | undefined): string => (v === null || v === undefined ? "" : String(v));
export const strOrNull = (v: SqlValue | undefined): string | null => (v === null || v === undefined ? null : String(v));
export const strOrUndef = (v: SqlValue | undefined): string | undefined => (v === null || v === undefined ? undefined : String(v));

export function encodeEmbedding(vec: number[] | null): Uint8Array | null {
  if (!vec) return null;
  return new Uint8Array(new Float32Array(vec).buffer);
}
export function decodeEmbedding(blob: SqlValue | undefined): number[] | null {
  if (!blob || !(blob instanceof Uint8Array)) return null;
  const f = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
  return Array.from(f);
}
