import type { AgentDefinition, Tool } from "@crucible/agents";
import type { Store } from "@crucible/core";
import type { RagPipeline } from "@crucible/rag";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { AppContext } from "./context.js";

/**
 * Agents the server can run, replay and fork itself. Register your own with `registry.register(def)`
 * from a plugin file (see `crucible.config.ts`). Runs recorded by the SDK from external agents can
 * still be inspected, diffed and event-forked, but only registered agents can be resumed live.
 */
export class AgentRegistry {
  private defs = new Map<string, AgentDefinition>();
  register(def: AgentDefinition) { this.defs.set(def.name, def); return this; }
  get(name: string) { return this.defs.get(name); }
  list() { return [...this.defs.values()].map((d) => ({ name: d.name, model: d.model.model, tools: (d.tools ?? []).map((t) => ({ name: t.name, description: t.description, requiresApproval: !!t.requiresApproval })), maxSteps: d.maxSteps ?? 20 })); }
}

/** Demo agents that work offline with the mock provider and show off every feature. */
export function demoAgents(store: Store, rag: RagPipeline, model = "mock-smart"): AgentDefinition[] {
  const search: Tool = {
    name: "search_knowledge", description: "Search the project's knowledge bases", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    handler: async ({ query }, ctx) => {
      const kbs = store.rag.listKbs(ctx.projectId);
      if (!kbs.length) return "no knowledge bases configured";
      const hits = await rag.retrieve(kbs[0]!, String(query), { k: 3 });
      return hits.map((h) => `- (${h.score.toFixed(3)}) ${h.chunk.text.slice(0, 300)}`).join("\n") || "no results";
    },
  };
  const calculator: Tool = {
    name: "calculate", description: "Evaluate an arithmetic expression", inputSchema: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] },
    handler: ({ expression }) => {
      const expr = String(expression);
      if (!/^[\d\s+\-*/().%]+$/.test(expr)) throw new Error("only arithmetic is allowed");
      return String(Function(`"use strict"; return (${expr})`)());
    },
  };
  const deploy: Tool = {
    name: "deploy", description: "Deploy a service to an environment (requires approval in production)", inputSchema: { type: "object", properties: { service: { type: "string" }, environment: { type: "string", enum: ["staging", "production"] } }, required: ["service", "environment"] },
    requiresApproval: (input) => input.environment === "production",
    handler: ({ service, environment }) => `deployed ${service} to ${environment} (simulated)`,
  };
  return [
    { name: "researcher", system: "You are a research assistant. Use search_knowledge to ground answers, then answer concisely.", model: { model, maxTokens: 1024 }, tools: [search, calculator], maxSteps: 8, maxCostUsd: 1 },
    { name: "release-manager", system: "You manage deployments. Always deploy to staging before production.", model: { model, maxTokens: 512 }, tools: [deploy], maxSteps: 6 },
  ];
}

/**
 * Load user-defined agents from `crucible.agents.mjs` in the working directory (or the path in
 * $CRUCIBLE_AGENTS). The module may export `agents` (an array of AgentDefinition) and/or a default
 * function `(ctx) => AgentDefinition[] | Promise<AgentDefinition[]>` that receives the app context
 * so tools can use the store, the gateway and RAG pipelines.
 */
export async function loadUserAgents(ctx: AppContext): Promise<number> {
  const file = resolve(process.cwd(), process.env.CRUCIBLE_AGENTS ?? "crucible.agents.mjs");
  if (!existsSync(file)) return 0;
  const mod = (await import(pathToFileURL(file).href)) as { agents?: AgentDefinition[]; default?: (ctx: AppContext) => AgentDefinition[] | Promise<AgentDefinition[]> };
  const defs = [...(mod.agents ?? []), ...(typeof mod.default === "function" ? await mod.default(ctx) : [])];
  for (const d of defs) ctx.agents.register(d);
  return defs.length;
}
