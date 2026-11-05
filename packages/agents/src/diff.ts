import type { AgentEvent, Store } from "@crucible/core";

export interface RunDiff {
  sharedPrefix: number;
  divergedAtSeq: number | null;
  a: { runId: string; events: number; costUsd: number; status: string; output: string | null };
  b: { runId: string; events: number; costUsd: number; status: string; output: string | null };
  changes: Array<{ seq: number; type: string; a: unknown; b: unknown }>;
}

const sig = (e: AgentEvent) => JSON.stringify({ t: e.type, p: stripVolatile(e.payload) });
function stripVolatile(p: unknown): unknown {
  if (!p || typeof p !== "object") return p;
  const { usage: _u, costUsd: _c, replayed: _r, model: _m, mode: _mo, sourceRunId: _s, forkAtSeq: _f, hash: _h, replayMatch: _rm, divergedAtSeq: _d, ...rest } = p as Record<string, unknown>;
  return rest;
}
const outputOf = (evs: AgentEvent[]) => (evs.find((e) => e.type === "run_finished")?.payload as { output?: string } | undefined)?.output ?? null;

/** Compare two runs event-by-event; useful after a fork or a model swap. */
export function diffRuns(store: Store, aId: string, bId: string): RunDiff {
  const A = store.agents.getRun(aId), B = store.agents.getRun(bId);
  if (!A || !B) throw new Error("run not found");
  const ea = store.agents.events(aId), eb = store.agents.events(bId);
  let i = 0;
  while (i < ea.length && i < eb.length && sig(ea[i]!) === sig(eb[i]!)) i++;
  const changes: RunDiff["changes"] = [];
  for (let k = i; k < Math.max(ea.length, eb.length) && changes.length < 50; k++) {
    const x = ea[k], y = eb[k];
    if (!x || !y || sig(x) !== sig(y)) changes.push({ seq: k, type: x?.type ?? y?.type ?? "?", a: x?.payload, b: y?.payload });
  }
  return {
    sharedPrefix: i, divergedAtSeq: i < Math.max(ea.length, eb.length) ? i : null,
    a: { runId: aId, events: ea.length, costUsd: A.costUsd, status: A.status, output: outputOf(ea) },
    b: { runId: bId, events: eb.length, costUsd: B.costUsd, status: B.status, output: outputOf(eb) },
    changes,
  };
}
