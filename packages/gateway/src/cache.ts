import { createHash } from "node:crypto";
import type { ChatRequest, ChatResponse } from "@crucible/core";

export function requestKey(req: ChatRequest): string {
  const { metadata: _m, stream: _s, ...rest } = req;
  return createHash("sha256").update(JSON.stringify(rest)).digest("hex");
}

export interface CacheStore {
  get(key: string): ChatResponse | undefined;
  set(key: string, value: ChatResponse, ttlMs: number): void;
  size(): number;
  clear(): void;
}

/** In-memory LRU with TTL. The server can wrap this with the SQLite kv table for persistence. */
export class MemoryCache implements CacheStore {
  private map = new Map<string, { value: ChatResponse; expires: number }>();
  constructor(private max = 5000) {}
  get(key: string) {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expires < Date.now()) { this.map.delete(key); return undefined; }
    this.map.delete(key); this.map.set(key, e); // refresh LRU position
    return e.value;
  }
  set(key: string, value: ChatResponse, ttlMs: number) {
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value!);
    this.map.set(key, { value, expires: Date.now() + ttlMs });
  }
  size() { return this.map.size; }
  clear() { this.map.clear(); }
}
