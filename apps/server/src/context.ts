import type { Store } from "@crucible/core";
import type { Gateway } from "@crucible/gateway";
import type { AgentRuntime } from "@crucible/agents";
import type { RagPipeline } from "@crucible/rag";
import type { Bus } from "./bus.js";
import type { AgentRegistry } from "./agents-registry.js";

export interface AppContext {
  store: Store;
  gateway: Gateway;
  runtime: AgentRuntime;
  rag: RagPipeline;
  bus: Bus;
  agents: AgentRegistry;
  /** Optional admin token protecting /api. When unset, the server is in trusted local mode. */
  adminToken?: string;
  /** Background eval jobs by eval id. */
  jobs: Map<string, { done: number; total: number; status: string; error?: string }>;
}

export type Env = { Variables: { ctx: AppContext; projectId: string; apiKeyId: string | null; actor: string } };
