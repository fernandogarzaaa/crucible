import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import type { Chunk, Json, KnowledgeBase, Store } from "@crucible/core";
import { hashEmbed, type Gateway } from "@crucible/gateway";
import { chunkText, htmlToText } from "./chunk.js";

export interface Embedder { model: string; embed(texts: string[]): Promise<number[][]> }

/** Embedder backed by the gateway, falling back to a local hash embedding for the "local-*" models. */
export function makeEmbedder(gateway: Gateway | undefined, projectId: string, model: string): Embedder {
  if (model.startsWith("local-") || !gateway) {
    const dims = Number(model.split("-").pop()) || 256;
    return { model, embed: async (texts) => texts.map((t) => hashEmbed(t, dims)) };
  }
  return { model, embed: async (texts) => {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 64) out.push(...(await gateway.embed(model, texts.slice(i, i + 64), { projectId, scopes: ["project"] })).embeddings);
    return out;
  } };
}

export interface IngestResult { documents: number; chunks: number; skipped: number }

export class RagPipeline {
  constructor(private readonly store: Store, private readonly gateway?: Gateway) {}

  async ingestText(kb: KnowledgeBase, doc: { source: string; title?: string; content: string; metadata?: Record<string, Json> }): Promise<{ changed: boolean; chunks: number }> {
    const pieces = chunkText(doc.content, { chunkSize: kb.chunkSize, chunkOverlap: kb.chunkOverlap });
    const existing = this.store.rag.listDocuments(kb.id).find((d) => d.source === doc.source);
    // Skip embedding when the content hash matches (upsert is a no-op anyway).
    const { contentHash } = await import("@crucible/core");
    if (existing && existing.contentHash === contentHash(doc.content)) return { changed: false, chunks: existing.chunkCount };
    const embedder = makeEmbedder(this.gateway, kb.projectId, kb.embeddingModel);
    const vectors = pieces.length ? await embedder.embed(pieces.map((p) => p.text)) : [];
    const { changed } = this.store.rag.upsertDocument({
      knowledgeBaseId: kb.id, source: doc.source, title: doc.title ?? doc.source, content: doc.content, metadata: doc.metadata ?? {},
      chunks: pieces.map((p, i) => ({ text: p.text, embedding: vectors[i] ?? null, metadata: { start: p.start } })),
    });
    return { changed, chunks: pieces.length };
  }

  /** Ingest a directory of .md/.txt/.html/.json files (recursively). */
  async ingestDirectory(kb: KnowledgeBase, dir: string, opts: { extensions?: string[]; onFile?: (f: string, r: { changed: boolean; chunks: number }) => void } = {}): Promise<IngestResult> {
    const exts = new Set(opts.extensions ?? [".md", ".mdx", ".txt", ".html", ".htm", ".json", ".rst"]);
    const files: string[] = [];
    const walk = async (d: string) => {
      for (const name of await readdir(d)) {
        if (name.startsWith(".") || name === "node_modules" || name === "dist") continue;
        const p = join(d, name);
        const s = await stat(p);
        if (s.isDirectory()) await walk(p);
        else if (exts.has(extname(name).toLowerCase())) files.push(p);
      }
    };
    await walk(dir);
    const result: IngestResult = { documents: 0, chunks: 0, skipped: 0 };
    for (const f of files) {
      let content = await readFile(f, "utf8");
      if (/\.html?$/.test(f)) content = htmlToText(content);
      const r = await this.ingestText(kb, { source: relative(dir, f), title: relative(dir, f), content, metadata: { path: f } });
      opts.onFile?.(f, r);
      if (r.changed) { result.documents++; result.chunks += r.chunks; } else result.skipped++;
    }
    return result;
  }

  /** Hybrid retrieval: vector + BM25 fused with reciprocal rank fusion, optional LLM rerank. */
  async retrieve(kb: KnowledgeBase, query: string, opts: { k?: number; mode?: "hybrid" | "vector" | "keyword"; rerankModel?: string; traceId?: string | null } = {}): Promise<Array<{ chunk: Chunk; score: number; signals: { vector?: number; keyword?: number; rerank?: number } }>> {
    const k = opts.k ?? 5;
    const mode = opts.mode ?? "hybrid";
    const span = opts.traceId ? this.store.tracing.startSpan({ traceId: opts.traceId, name: "retrieve", kind: "retriever", input: { query, k, mode }, attributes: { knowledgeBase: kb.name } }) : null;
    const fetchK = Math.max(k * 4, 20);
    const vec = mode !== "keyword" ? this.store.rag.vectorSearch(kb.id, (await makeEmbedder(this.gateway, kb.projectId, kb.embeddingModel).embed([query]))[0]!, fetchK) : [];
    const kw = mode !== "vector" ? this.store.rag.keywordSearch(kb.id, query, fetchK) : [];
    const fused = new Map<string, { score: number; signals: { vector?: number; keyword?: number; rerank?: number } }>();
    const RRF_K = 60;
    vec.forEach((r, i) => { const e = fused.get(r.chunkId) ?? { score: 0, signals: {} }; e.score += 1 / (RRF_K + i + 1); e.signals.vector = r.score; fused.set(r.chunkId, e); });
    kw.forEach((r, i) => { const e = fused.get(r.chunkId) ?? { score: 0, signals: {} }; e.score += 1 / (RRF_K + i + 1); e.signals.keyword = r.score; fused.set(r.chunkId, e); });
    let ranked = [...fused.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, opts.rerankModel ? Math.max(k * 2, 10) : k)
      .map(([chunkId, v]) => ({ chunk: this.store.rag.getChunk(chunkId)!, ...v })).filter((r) => r.chunk);
    if (opts.rerankModel && this.gateway && ranked.length) {
      ranked = await this.rerank(kb.projectId, query, ranked, opts.rerankModel, opts.traceId ?? null);
      ranked = ranked.slice(0, k);
    }
    if (span) this.store.tracing.endSpan(span.id, { output: ranked.map((r) => ({ chunkId: r.chunk.id, documentId: r.chunk.documentId, score: r.score, preview: r.chunk.text.slice(0, 120) })) });
    return ranked;
  }

  private async rerank<T extends { chunk: Chunk; score: number; signals: { rerank?: number } }>(projectId: string, query: string, items: T[], model: string, traceId: string | null): Promise<T[]> {
    const prompt = `Rate how relevant each passage is to the query on a 0-10 scale. Reply with a JSON array of numbers only, one per passage, in order.\n\nQUERY: ${query}\n\n${items.map((it, i) => `[${i}] ${it.chunk.text.slice(0, 800)}`).join("\n\n")}`;
    try {
      const res = await this.gateway!.chat({ messages: [{ role: "user", content: prompt }], config: { model, temperature: 0, maxTokens: 200 } }, { projectId, traceId, scopes: ["project"] });
      const text = typeof res.message.content === "string" ? res.message.content : res.message.content.map((p) => (p.type === "text" ? p.text : "")).join("");
      const arr = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] ?? "[]") as number[];
      if (arr.length === items.length) {
        items.forEach((it, i) => { it.signals.rerank = arr[i]!; it.score = arr[i]! / 10; });
        return [...items].sort((a, b) => b.score - a.score);
      }
    } catch { /* fall back to fused order */ }
    return items;
  }

  /**
   * Retrieval eval: each case has a query and the expected document sources (or text substrings).
   * Reports recall@k, MRR and hit rate so chunking/embedding changes can be compared objectively.
   */
  async evaluateRetrieval(kb: KnowledgeBase, cases: Array<{ query: string; expectedSources?: string[]; expectedText?: string[] }>, opts: { k?: number; mode?: "hybrid" | "vector" | "keyword" } = {}): Promise<{ k: number; recallAtK: number; mrr: number; hitRate: number; perCase: Array<{ query: string; hit: boolean; rank: number | null; retrieved: string[] }> }> {
    const k = opts.k ?? 5;
    const docs = new Map(this.store.rag.listDocuments(kb.id).map((d) => [d.id, d.source]));
    const perCase: Array<{ query: string; hit: boolean; rank: number | null; retrieved: string[] }> = [];
    let recall = 0, mrr = 0;
    for (const c of cases) {
      const results = await this.retrieve(kb, c.query, { k, mode: opts.mode });
      const retrieved = results.map((r) => docs.get(r.chunk.documentId) ?? r.chunk.documentId);
      const matches = results.map((r, i) => ({ i, ok: (c.expectedSources ?? []).includes(docs.get(r.chunk.documentId) ?? "") || (c.expectedText ?? []).some((t) => r.chunk.text.toLowerCase().includes(t.toLowerCase())) }));
      const first = matches.find((m) => m.ok);
      const expectedCount = Math.max(1, (c.expectedSources?.length ?? 0) + (c.expectedText?.length ?? 0));
      const found = new Set<string>();
      for (const r of results) {
        const src = docs.get(r.chunk.documentId) ?? "";
        if (c.expectedSources?.includes(src)) found.add(`s:${src}`);
        for (const t of c.expectedText ?? []) if (r.chunk.text.toLowerCase().includes(t.toLowerCase())) found.add(`t:${t}`);
      }
      recall += Math.min(1, found.size / expectedCount);
      mrr += first ? 1 / (first.i + 1) : 0;
      perCase.push({ query: c.query, hit: !!first, rank: first ? first.i + 1 : null, retrieved });
    }
    const n = Math.max(1, cases.length);
    return { k, recallAtK: recall / n, mrr: mrr / n, hitRate: perCase.filter((p) => p.hit).length / n, perCase };
  }
}
