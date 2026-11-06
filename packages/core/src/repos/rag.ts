import { createHash } from "node:crypto";
import type { Db, Row } from "../db.js";
import { decodeEmbedding, encodeEmbedding, j, num, str } from "../db.js";
import { newId } from "../ids.js";
import type { Chunk, Document, Json, KnowledgeBase } from "../schema.js";

const rowKb = (r: Row): KnowledgeBase => ({
  id: str(r.id), projectId: str(r.project_id), name: str(r.name), embeddingModel: str(r.embedding_model), chunkSize: num(r.chunk_size),
  chunkOverlap: num(r.chunk_overlap), createdAt: num(r.created_at),
});
const rowDoc = (r: Row): Document => ({
  id: str(r.id), knowledgeBaseId: str(r.knowledge_base_id), source: str(r.source), title: str(r.title), contentHash: str(r.content_hash),
  metadata: j.dec<Record<string, Json>>(r.metadata, {}), chunkCount: num(r.chunk_count), createdAt: num(r.created_at),
});
const rowChunk = (r: Row): Chunk => ({
  id: str(r.id), documentId: str(r.document_id), knowledgeBaseId: str(r.knowledge_base_id), index: num(r.idx), text: str(r.text),
  embedding: decodeEmbedding(r.embedding), metadata: j.dec<Record<string, Json>>(r.metadata, {}),
});

export const contentHash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

export class RagRepo {
  constructor(private db: Db) {}

  createKb(input: { projectId: string; name: string; embeddingModel?: string; chunkSize?: number; chunkOverlap?: number }): KnowledgeBase {
    const kb: KnowledgeBase = {
      id: newId.knowledgeBase(), projectId: input.projectId, name: input.name, embeddingModel: input.embeddingModel ?? "local-hash-256",
      chunkSize: input.chunkSize ?? 800, chunkOverlap: input.chunkOverlap ?? 100, createdAt: Date.now(),
    };
    this.db.run("INSERT INTO knowledge_bases (id, project_id, name, embedding_model, chunk_size, chunk_overlap, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", kb.id, kb.projectId, kb.name, kb.embeddingModel, kb.chunkSize, kb.chunkOverlap, kb.createdAt);
    return kb;
  }
  getKb(projectId: string, idOrName: string): KnowledgeBase | undefined {
    const r = this.db.get("SELECT * FROM knowledge_bases WHERE project_id = ? AND (id = ? OR name = ?)", projectId, idOrName, idOrName);
    return r ? rowKb(r) : undefined;
  }
  getKbById(id: string): KnowledgeBase | undefined {
    const r = this.db.get("SELECT * FROM knowledge_bases WHERE id = ?", id);
    return r ? rowKb(r) : undefined;
  }
  listKbs(projectId: string): Array<KnowledgeBase & { documentCount: number; chunkCount: number }> {
    return this.db
      .all(
        `SELECT k.*, (SELECT COUNT(*) FROM documents d WHERE d.knowledge_base_id = k.id) doc_count,
                (SELECT COUNT(*) FROM chunks c WHERE c.knowledge_base_id = k.id) chunk_count
         FROM knowledge_bases k WHERE k.project_id = ? ORDER BY k.name`, projectId,
      )
      .map((r) => ({ ...rowKb(r), documentCount: num(r.doc_count), chunkCount: num(r.chunk_count) }));
  }
  deleteKb(id: string): void {
    this.db.run("DELETE FROM chunks_fts WHERE knowledge_base_id = ?", id);
    this.db.run("DELETE FROM knowledge_bases WHERE id = ?", id);
  }

  /** Upsert a document with its chunks. Re-ingesting unchanged content is a no-op. */
  upsertDocument(input: { knowledgeBaseId: string; source: string; title: string; content: string; metadata?: Record<string, Json>; chunks: Array<{ text: string; embedding: number[] | null; metadata?: Record<string, Json> }> }): { document: Document; changed: boolean } {
    const hash = contentHash(input.content);
    const existing = this.db.get("SELECT * FROM documents WHERE knowledge_base_id = ? AND source = ?", input.knowledgeBaseId, input.source);
    if (existing && str(existing.content_hash) === hash) return { document: rowDoc(existing), changed: false };
    return this.db.transaction(() => {
      if (existing) this.deleteDocument(str(existing.id));
      const doc: Document = {
        id: newId.document(), knowledgeBaseId: input.knowledgeBaseId, source: input.source, title: input.title, contentHash: hash,
        metadata: input.metadata ?? {}, chunkCount: input.chunks.length, createdAt: Date.now(),
      };
      this.db.run("INSERT INTO documents (id, knowledge_base_id, source, title, content_hash, metadata, chunk_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", doc.id, doc.knowledgeBaseId, doc.source, doc.title, hash, j.enc(doc.metadata), doc.chunkCount, doc.createdAt);
      input.chunks.forEach((c, i) => {
        const id = newId.chunk();
        this.db.run("INSERT INTO chunks (id, document_id, knowledge_base_id, idx, text, embedding, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)", id, doc.id, doc.knowledgeBaseId, i, c.text, encodeEmbedding(c.embedding), j.enc(c.metadata ?? {}));
        this.db.run("INSERT INTO chunks_fts (text, chunk_id, knowledge_base_id) VALUES (?, ?, ?)", c.text, id, doc.knowledgeBaseId);
      });
      return { document: doc, changed: true };
    });
  }
  listDocuments(kbId: string): Document[] {
    return this.db.all("SELECT * FROM documents WHERE knowledge_base_id = ? ORDER BY created_at DESC", kbId).map(rowDoc);
  }
  deleteDocument(id: string): void {
    this.db.run("DELETE FROM chunks_fts WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)", id);
    this.db.run("DELETE FROM documents WHERE id = ?", id);
  }
  chunksForDocument(docId: string): Chunk[] {
    return this.db.all("SELECT * FROM chunks WHERE document_id = ? ORDER BY idx", docId).map(rowChunk);
  }
  allChunks(kbId: string): Chunk[] {
    return this.db.all("SELECT * FROM chunks WHERE knowledge_base_id = ?", kbId).map(rowChunk);
  }
  getChunk(id: string): Chunk | undefined {
    const r = this.db.get("SELECT * FROM chunks WHERE id = ?", id);
    return r ? rowChunk(r) : undefined;
  }

  /** BM25 keyword search via FTS5. Returns chunk ids with normalized scores (higher is better). */
  keywordSearch(kbId: string, query: string, k: number): Array<{ chunkId: string; score: number }> {
    if (this.db.dialect === "postgres") {
      const terms = query.replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/).filter(Boolean).join(" | ");
      if (!terms) return [];
      const rows = this.db.all<{ chunk_id: string; rank: number }>(
        "SELECT chunk_id, ts_rank_cd(tsv, to_tsquery('english', ?)) AS rank FROM chunks_fts WHERE knowledge_base_id = ? AND tsv @@ to_tsquery('english', ?) ORDER BY rank DESC LIMIT ?", terms, kbId, terms, k,
      );
      return rows.map((r) => ({ chunkId: r.chunk_id, score: Number(r.rank) }));
    }
    const safe = query.replace(/["*():^]/g, " ").trim().split(/\s+/).filter(Boolean).map((t) => `"${t}"`).join(" OR ");
    if (!safe) return [];
    const rows = this.db.all<{ chunk_id: string; rank: number }>(
      "SELECT chunk_id, bm25(chunks_fts) AS rank FROM chunks_fts WHERE knowledge_base_id = ? AND chunks_fts MATCH ? ORDER BY rank LIMIT ?", kbId, safe, k,
    );
    return rows.map((r) => ({ chunkId: r.chunk_id, score: -Number(r.rank) }));
  }

  /** Brute-force vector search. Fine up to ~100k chunks locally; swap for sqlite-vec / pgvector beyond that. */
  vectorSearch(kbId: string, query: number[], k: number): Array<{ chunkId: string; score: number }> {
    const scored: Array<{ chunkId: string; score: number }> = [];
    for (const c of this.allChunks(kbId)) if (c.embedding) scored.push({ chunkId: c.id, score: cosine(query, c.embedding) });
    return scored.sort((a, b) => b.score - a.score).slice(0, k);
  }
}
