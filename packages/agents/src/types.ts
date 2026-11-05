import type { AgentEvent, AgentRun, ContentPart, Json, Message, ModelConfig, ToolDefinition } from "@crucible/core";

export interface ToolContext { runId: string; projectId: string; step: number; signal?: AbortSignal }

export interface Tool extends ToolDefinition {
  handler: (input: Record<string, Json>, ctx: ToolContext) => Promise<Json> | Json;
  /** When true (or when the predicate returns true) a human must approve before the tool runs. */
  requiresApproval?: boolean | ((input: Record<string, Json>) => boolean);
}

export interface AgentDefinition {
  name: string;
  system?: string;
  model: ModelConfig;
  tools?: Tool[];
  maxSteps?: number;
  /** Hard budget for this run in USD; the run is killed when exceeded. */
  maxCostUsd?: number;
  /** Called after each step; returning false stops the run. */
  shouldContinue?: (state: AgentState) => boolean;
}

export interface AgentState {
  messages: Message[];
  step: number;
  costUsd: number;
  lastToolUses: Array<Extract<ContentPart, { type: "tool_use" }>>;
}

export type RunMode = "live" | "replay" | "fork";

export interface RunOptions {
  projectId: string;
  input: string | Message[];
  metadata?: Record<string, Json>;
  mode?: RunMode;
  /** For replay/fork: the run to read recorded events from. */
  sourceRunId?: string;
  /** For fork: use recorded events up to and including this seq, then go live. */
  forkAtSeq?: number;
  /** For fork: replace the payload of one recorded event (e.g. a tool result) before resuming. */
  replaceEvent?: { seq: number; payload: Json };
  /** How long to wait for a pending approval before failing the run. */
  approvalTimeoutMs?: number;
  signal?: AbortSignal;
  onEvent?: (ev: AgentEvent) => void;
}

export interface RunResult { run: AgentRun; output: string; state: AgentState }
