import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32

/** Sortable, URL-safe, 26-char identifier (ULID layout). */
export function ulid(now: number = Date.now()): string {
  let time = now;
  let out = "";
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[time % 32] + out;
    time = Math.floor(time / 32);
  }
  const rand = randomBytes(16);
  for (let i = 0; i < 16; i++) out += ALPHABET[rand[i]! % 32];
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
