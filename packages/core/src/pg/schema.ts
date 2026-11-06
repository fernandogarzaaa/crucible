import { SQLITE_MIGRATIONS } from "../db.js";

/**
 * Postgres DDL is derived from the SQLite migrations so there is one source of truth for the schema.
 * Differences: millisecond timestamps need BIGINT, REAL becomes DOUBLE PRECISION, BLOB becomes BYTEA,
 * and the FTS5 virtual table becomes a regular table with a generated tsvector column.
 */
export const POSTGRES_MIGRATIONS: string[] = SQLITE_MIGRATIONS.map((sql) =>
  sql
    .replace(/CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5\([^;]*\);/, `
  CREATE TABLE IF NOT EXISTS chunks_fts (
    chunk_id TEXT PRIMARY KEY, knowledge_base_id TEXT NOT NULL, text TEXT NOT NULL,
    tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED
  );
  CREATE INDEX IF NOT EXISTS idx_chunks_fts_tsv ON chunks_fts USING GIN (tsv);
  CREATE INDEX IF NOT EXISTS idx_chunks_fts_kb ON chunks_fts(knowledge_base_id);`)
    .replace(/\bINTEGER PRIMARY KEY\b/g, "BIGINT PRIMARY KEY")
    .replace(/\bINTEGER\b/g, "BIGINT")
    .replace(/\bREAL\b/g, "DOUBLE PRECISION")
    .replace(/\bBLOB\b/g, "BYTEA"),
);
