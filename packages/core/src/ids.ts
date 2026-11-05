import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32

let lastTime = -1;
let lastRand: number[] = [];

/**
 * Sortable, URL-safe, 26-char identifier (ULID layout). Monotonic within a process: ids generated in the
 * same millisecond increment the random part, so `ORDER BY id` reproduces creation order on any database.
 */
export function ulid(now: number = Date.now()): string {
  let time = now;
  let out = "";
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[time % 32] + out;
    time = Math.floor(time / 32);
  }
  if (now === lastTime) {
    // increment the 80-bit random part (base32 digits, little-endian carry from the end)
    for (let i = 15; i >= 0; i--) { lastRand[i] = (lastRand[i]! + 1) % 32; if (lastRand[i] !== 0) break; }
  } else {
    lastTime = now;
    const rand = randomBytes(16);
    lastRand = Array.from(rand, (b) => b % 32);
    lastRand[0] = lastRand[0]! % 16; // headroom so increments never overflow within one ms
  }
  for (let i = 0; i < 16; i++) out += ALPHABET[lastRand[i]!];
  return out;
}

export function id(prefix: string): string {
  return `${prefix}_${ulid()}`;
}

export const newId = {
  project: () => id("proj"),
  prompt: () => id("pr"),
  promptVersion: () => id("prv"),
  dataset: () => id("ds"),
  datasetItem: () => id("dsi"),
  trace: () => id("tr"),
  span: () => id("sp"),
  eval: () => id("ev"),
  evalResult: () => id("evr"),
  agentRun: () => id("run"),
  agentEvent: () => id("evt"),
  gatewayRequest: () => id("gw"),
  budget: () => id("bud"),
  knowledgeBase: () => id("kb"),
  document: () => id("doc"),
  chunk: () => id("ch"),
  approval: () => id("apr"),
  audit: () => id("aud"),
  apiKey: () => id("key"),
  alert: () => id("alr"),
};
