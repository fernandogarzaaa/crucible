import { z } from "zod";

/** Shared JSON value type. */
export const Json: z.ZodType<unknown> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(Json), z.record(Json)]),
);
export type Json = z.infer<typeof Json>;

// ---------- Chat primitives (provider-neutral) ----------

export const ContentPart = z.union([
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("image"), mediaType: z.string(), data: z.string() }),
  z.object({
    type: z.literal("tool_use"),
    id: z.string(),
    name: z.string(),
    input: Json,
  }),
  z.object({
    type: z.literal("tool_result"),
    toolUseId: z.string(),
    content: z.string(),
    isError: z.boolean().optional(),
  }),
]);
export type ContentPart = z.infer<typeof ContentPart>;

export const Message = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.union([z.string(), z.array(ContentPart)]),
  name: z.string().optional(),
});
export type Message = z.infer<typeof Message>;

export const ToolDefinition = z.object({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: z.record(Json),
});
export type ToolDefinition = z.infer<typeof ToolDefinition>;

export const ModelConfig = z.object({
  model: z.string(),
  provider: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  topP: z.number().min(0).max(1).optional(),
  stopSequences: z.array(z.string()).optional(),
  tools: z.array(ToolDefinition).optional(),
  toolChoice: z.union([z.literal("auto"), z.literal("none"), z.literal("required"), z.object({ name: z.string() })]).optional(),
  responseFormat: z.union([z.literal("text"), z.literal("json")]).optional(),
});
export type ModelConfig = z.infer<typeof ModelConfig>;

export const Usage = z.object({
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
});
export type Usage = z.infer<typeof Usage>;

export const ChatRequest = z.object({
  messages: z.array(Message),
  config: ModelConfig,
  metadata: z.record(Json).optional(),
  stream: z.boolean().optional(),
});
export type ChatRequest = z.infer<typeof ChatRequest>;

export const ChatResponse = z.object({
  id: z.string(),
  model: z.string(),
  provider: z.string(),
  message: Message,
  stopReason: z.enum(["end_turn", "max_tokens", "tool_use", "stop_sequence", "error"]),
  usage: Usage,
  costUsd: z.number().nonnegative(),
  latencyMs: z.number().nonnegative(),
  cached: z.boolean().default(false),
});
export type ChatResponse = z.infer<typeof ChatResponse>;

// ---------- Projects / prompts / datasets ----------

export const Project = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  createdAt: z.number(),
});
export type Project = z.infer<typeof Project>;

export const Prompt = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  description: z.string().optional(),
  createdAt: z.number(),
});
export type Prompt = z.infer<typeof Prompt>;

export const PromptVersion = z.object({
  id: z.string(),
  promptId: z.string(),
  version: z.number().int().positive(),
  /** Messages may contain `{{variable}}` placeholders. */
  template: z.array(Message),
  config: ModelConfig,
  variables: z.array(z.string()),
  commitMessage: z.string().optional(),
  labels: z.array(z.string()),
  createdAt: z.number(),
});
export type PromptVersion = z.infer<typeof PromptVersion>;

export const Dataset = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  description: z.string().optional(),
  createdAt: z.number(),
});
export type Dataset = z.infer<typeof Dataset>;

export const DatasetItem = z.object({
  id: z.string(),
  datasetId: z.string(),
  input: z.record(Json),
  expected: Json.optional(),
  metadata: z.record(Json).optional(),
  createdAt: z.number(),
});
export type DatasetItem = z.infer<typeof DatasetItem>;

// ---------- Tracing (OTel GenAI-aligned) ----------

export const SpanKind = z.enum(["llm", "tool", "retriever", "embedding", "agent", "chain", "guardrail", "custom"]);
export type SpanKind = z.infer<typeof SpanKind>;

export const SpanStatus = z.enum(["ok", "error", "running"]);

export const Span = z.object({
  id: z.string(),
  traceId: z.string(),
  parentSpanId: z.string().nullable(),
  name: z.string(),
  kind: SpanKind,
  status: SpanStatus,
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  input: Json.optional(),
  output: Json.optional(),
  attributes: z.record(Json),
  model: z.string().optional(),
  provider: z.string().optional(),
  usage: Usage.optional(),
  costUsd: z.number().optional(),
  error: z.string().optional(),
});
export type Span = z.infer<typeof Span>;

export const Trace = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  status: SpanStatus,
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  input: Json.optional(),
  output: Json.optional(),
  metadata: z.record(Json),
  tags: z.array(z.string()),
  sessionId: z.string().optional(),
  userId: z.string().optional(),
  totalTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  spanCount: z.number().int().nonnegative(),
});
export type Trace = z.infer<typeof Trace>;

// ---------- Evals ----------

export const ScorerConfig = z.discriminatedUnion("type", [
  z.object({ type: z.literal("exact_match"), field: z.string().optional() }),
  z.object({ type: z.literal("contains"), value: z.string().optional(), caseSensitive: z.boolean().optional() }),
  z.object({ type: z.literal("regex"), pattern: z.string(), flags: z.string().optional() }),
  z.object({ type: z.literal("json_schema"), schema: z.record(Json) }),
  z.object({ type: z.literal("levenshtein"), threshold: z.number().min(0).max(1).optional() }),
  z.object({
    type: z.literal("llm_judge"),
    model: z.string(),
    rubric: z.string(),
    scale: z.tuple([z.number(), z.number()]).default([0, 1]),
    passThreshold: z.number().optional(),
  }),
  z.object({ type: z.literal("latency"), maxMs: z.number().positive() }),
  z.object({ type: z.literal("cost"), maxUsd: z.number().positive() }),
  z.object({ type: z.literal("custom"), module: z.string(), options: z.record(Json).optional() }),
]);
export type ScorerConfig = z.infer<typeof ScorerConfig>;

export const EvalStatus = z.enum(["pending", "running", "completed", "failed", "cancelled"]);

export const Eval = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  datasetId: z.string(),
  promptVersionId: z.string().nullable(),
  /** Alternative to a prompt version: evaluate a recorded agent run or an external target. */
  target: z.record(Json).optional(),
  scorers: z.array(ScorerConfig),
  status: EvalStatus,
  startedAt: z.number().nullable(),
  endedAt: z.number().nullable(),
  summary: z.record(Json),
  baselineEvalId: z.string().nullable(),
  createdAt: z.number(),
});
export type Eval = z.infer<typeof Eval>;

export const Score = z.object({
  name: z.string(),
  value: z.number(),
  passed: z.boolean().optional(),
  reason: z.string().optional(),
});
export type Score = z.infer<typeof Score>;

export const EvalResult = z.object({
  id: z.string(),
  evalId: z.string(),
  itemId: z.string(),
  output: Json,
  scores: z.array(Score),
  latencyMs: z.number(),
  costUsd: z.number(),
  traceId: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.number(),
});
export type EvalResult = z.infer<typeof EvalResult>;

// ---------- Agent runs (record / replay / fork) ----------

export const AgentEventType = z.enum([
  "run_started",
  "llm_request",
  "llm_response",
  "tool_call",
  "tool_result",
  "state_snapshot",
  "message",
  "approval_requested",
  "approval_resolved",
  "checkpoint",
  "error",
  "run_finished",
]);
export type AgentEventType = z.infer<typeof AgentEventType>;

export const AgentEvent = z.object({
  id: z.string(),
  runId: z.string(),
  seq: z.number().int().nonnegative(),
  type: AgentEventType,
  payload: Json,
  spanId: z.string().nullable(),
  ts: z.number(),
});
export type AgentEvent = z.infer<typeof AgentEvent>;

export const AgentRunStatus = z.enum(["running", "paused", "awaiting_approval", "completed", "failed", "killed"]);
export type AgentRunStatus = z.infer<typeof AgentRunStatus>;

export const AgentRun = z.object({
  id: z.string(),
  projectId: z.string(),
  agentName: z.string(),
  status: AgentRunStatus,
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  parentRunId: z.string().nullable(),
  forkedAtSeq: z.number().int().nullable(),
  traceId: z.string().nullable(),
  metadata: z.record(Json),
  costUsd: z.number().nonnegative(),
  eventCount: z.number().int().nonnegative(),
});
export type AgentRun = z.infer<typeof AgentRun>;

// ---------- Gateway ----------

export const GatewayRequest = z.object({
  id: z.string(),
  projectId: z.string(),
  apiKeyId: z.string().nullable(),
  requestedModel: z.string(),
  servedModel: z.string(),
  provider: z.string(),
  route: z.string(),
  status: z.number().int(),
  cached: z.boolean(),
  fallbackDepth: z.number().int().nonnegative(),
  latencyMs: z.number(),
  usage: Usage,
  costUsd: z.number(),
  traceId: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.number(),
});
export type GatewayRequest = z.infer<typeof GatewayRequest>;

export const Budget = z.object({
  id: z.string(),
  projectId: z.string(),
  /** e.g. "project", "key:<apiKeyId>", "agent:<name>", "model:<model>" */
  scope: z.string(),
  limitUsd: z.number().positive(),
  period: z.enum(["daily", "weekly", "monthly", "total"]),
  hardStop: z.boolean(),
  createdAt: z.number(),
});
export type Budget = z.infer<typeof Budget>;

export const ApiKey = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  prefix: z.string(),
  hash: z.string(),
  scopes: z.array(z.string()),
  createdAt: z.number(),
  lastUsedAt: z.number().nullable(),
  revokedAt: z.number().nullable(),
});
export type ApiKey = z.infer<typeof ApiKey>;

// ---------- RAG ----------

export const KnowledgeBase = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  embeddingModel: z.string(),
  chunkSize: z.number().int().positive(),
  chunkOverlap: z.number().int().nonnegative(),
  createdAt: z.number(),
});
export type KnowledgeBase = z.infer<typeof KnowledgeBase>;

export const Document = z.object({
  id: z.string(),
  knowledgeBaseId: z.string(),
  source: z.string(),
  title: z.string(),
  contentHash: z.string(),
  metadata: z.record(Json),
  chunkCount: z.number().int().nonnegative(),
  createdAt: z.number(),
});
export type Document = z.infer<typeof Document>;

export const Chunk = z.object({
  id: z.string(),
  documentId: z.string(),
  knowledgeBaseId: z.string(),
  index: z.number().int().nonnegative(),
  text: z.string(),
  embedding: z.array(z.number()).nullable(),
  metadata: z.record(Json),
});
export type Chunk = z.infer<typeof Chunk>;

// ---------- Ops: approvals, audit, alerts ----------

export const Approval = z.object({
  id: z.string(),
  projectId: z.string(),
  runId: z.string(),
  eventSeq: z.number().int(),
  title: z.string(),
  details: Json,
  status: z.enum(["pending", "approved", "rejected", "expired"]),
  requestedAt: z.number(),
  resolvedAt: z.number().nullable(),
  resolvedBy: z.string().nullable(),
  reason: z.string().nullable(),
});
export type Approval = z.infer<typeof Approval>;

export const AuditEntry = z.object({
  id: z.string(),
  projectId: z.string().nullable(),
  actor: z.string(),
  action: z.string(),
  targetType: z.string(),
  targetId: z.string(),
  details: z.record(Json),
  ts: z.number(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

export const AlertRule = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  /** e.g. error_rate > 0.1 over 5m, cost_usd > 50 over 1h, latency_p95_ms > 8000 over 15m */
  metric: z.enum(["error_rate", "cost_usd", "latency_p95_ms", "requests", "approval_pending_count"]),
  op: z.enum([">", ">=", "<", "<="]),
  threshold: z.number(),
  windowMinutes: z.number().int().positive(),
  enabled: z.boolean(),
  lastFiredAt: z.number().nullable(),
  createdAt: z.number(),
});
export type AlertRule = z.infer<typeof AlertRule>;
