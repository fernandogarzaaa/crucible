# Crucible architecture

## One store, many modules

Every module reads and writes the same SQLite file through `Store` (`packages/core/src/store.ts`). This is deliberate: the value of an all-in-one tool is the joins. An eval result links to the trace that produced it; an agent run links to its trace and to the gateway requests that priced it; an approval links to the exact event sequence number in a run; a budget is computed from the gateway request log. Point solutions cannot do these joins without a sync pipeline.

```
                    ┌──────────────── apps/web (React) ─────────────────┐
                    │  overview · prompts · datasets · evals · traces   │
                    │  agents/runs · gateway · knowledge · ops          │
                    └───────────────────────┬───────────────────────────┘
                                            │ JSON + SSE
┌─ clients ────────┐      ┌─────────────────┴──────────────── apps/server (Hono) ──┐
│ OpenAI SDK ──────┼─────▶│ /v1/chat/completions  /v1/messages  /v1/embeddings      │
│ Anthropic SDK ───┼─────▶│ /api/* (workbench, tracing, evals, agents, gateway,     │
│ @crucible/sdk ───┼─────▶│         rag, ops)        ingest · live feeds · auth     │
│ crucible CLI ────┼───┐  └────┬──────────┬───────────┬───────────┬───────────┬────┘
└──────────────────┘   │       │          │           │           │           │
                       │  ┌────▼────┐ ┌───▼────┐ ┌────▼────┐ ┌────▼───┐ ┌─────▼────┐
                       └─▶│ gateway │ │ evals  │ │ agents  │ │  rag   │ │  (ops)   │
                          │ router  │ │ runner │ │ runtime │ │pipeline│ │approvals │
                          │ cache   │ │scorers │ │ replay  │ │retrieve│ │audit     │
                          │ redact  │ │ spec   │ │ fork    │ │ r-eval │ │alerts    │
                          └────┬────┘ └───┬────┘ └────┬────┘ └───┬────┘ └─────┬────┘
                               └──────────┴───────────┴──────────┴────────────┘
                                                      │
                                            ┌─────────▼─────────┐
                                            │ @crucible/core    │
                                            │ Store → SQLite    │
                                            │ (WAL, FTS5)       │
                                            └───────────────────┘
```

## Key design decisions

**Provider-neutral message model.** `packages/core/src/schema.ts` defines `Message`, `ContentPart`, `ToolDefinition` and `ChatRequest/Response` once. Providers translate at the edge (`packages/gateway/src/providers/*`). The server's compatibility layer (`apps/server/src/compat.ts`) translates OpenAI and Anthropic wire formats to and from the same model, including streaming. This is what lets a route send one request to Anthropic and fall back to OpenAI.

**The gateway is the single door.** Evals, agents and the RAG reranker all call models through `Gateway.chat`, so budgets, caching, redaction, pricing and the request log apply uniformly. Nothing in the platform calls a provider directly.

**Agent runs are event logs, not state machines.** `AgentRuntime` records `llm_response` and `tool_result` events as the only non-deterministic inputs. Replay reads those from the recorded run instead of executing; fork reads them up to a sequence number and then goes live. This is the same "cassette" technique VCR-style HTTP mocking uses, applied to the two sources of non-determinism in an agent loop. The trade-off: replay is only deterministic for the recorded prefix. Anything after the fork point is live and will differ. LangGraph's time travel has the same property (its docs say replay re-executes nodes after the checkpoint).

**Vendor CLIs as providers.** `CliProvider` (`packages/gateway/src/providers/cli/`) runs a CLI per request in an empty scratch directory, reads its JSON event stream line by line, and maps it onto the gateway's stream events. The process group is killed on a hard timeout, on an idle timeout (no stdout for 90 s by default), on client abort, or when the consumer stops reading. Each subclass only builds the command line and parses its CLI's events: Claude Code `stream-json` (Messages API stream events plus a `result`), Codex `exec --json` (`item.*` and `turn.*`), OpenCode `run --format json` (`text` parts and `step_finish`), and Cline `--json` (`agent_event` chunks and `run_result`). Their parsers are tested against streams recorded from the real CLIs. Because current Codex only speaks the Responses API, Crucible also serves `/v1/responses`, which lets Codex use Crucible itself as its backend.

**Human approvals are tool-level.** A tool declares `requiresApproval` (boolean or predicate on the input). The runtime writes an `approvals` row and polls it, so the approval can come from the UI, the CLI, or any HTTP client. The run status becomes `awaiting_approval` so fleet views can surface it.

**Spans follow the OpenTelemetry GenAI vocabulary** (`llm`, `tool`, `retriever`, `embedding`, `agent`, `chain`), and the OTLP receiver maps incoming `gen_ai.*` spans onto the same table. Message content is stored by default because this is a debugging tool; redaction at the gateway is the control for sensitive inputs. Note the upstream conventions mark message content as opt-in for exactly this reason.

**Local-first, Postgres included.** Every repository class takes the `Db` interface and uses plain SQL. `SqliteDb` wraps `node:sqlite`; `PostgresDb` runs node-postgres (or PGlite) in a worker thread and exposes it synchronously through `Atomics.wait` plus `receiveMessageOnPort`, so repositories never changed when Postgres arrived. The Postgres DDL is derived from the SQLite migrations with type substitutions, and the only dialect branch in the repositories is full-text search (FTS5 vs tsvector). Vector search is brute-force cosine in process, which is fine to roughly 100k chunks; `sqlite-vec` or `pgvector` are the upgrade path.

**Input-matched replay.** Each `llm_request` event carries a hash of the messages plus tool names, and each `tool_call` a hash of tool name plus input. In replay and fork, a recorded response is reused only when the live request produces the same hash; at the first mismatch the runtime emits a `checkpoint` event, records `divergedAtSeq` on the run, and continues live. This is what makes "fork after a prompt change" meaningful: the unaffected prefix is free, and the divergence point is the regression signal. `replayMatch: "order"` restores classic sequential VCR behaviour. `replayBoundaries` chooses which boundaries come from the recording: `["llm"]` replays model decisions and runs tools live with the current code (cut-point replay, which catches tool-guard regressions that full stubbing hides), `["tool"]` freezes the environment and calls the model live.

**OTLP ingest.** `POST /v1/traces` accepts OTLP/HTTP JSON and maps `gen_ai.*` attributes onto spans (operation name to span kind, request/response model, provider, usage, opt-in message content, tool arguments and results). The scope schema URL is stored per span because the GenAI conventions are still unreleased and attribute names have changed between versions.

**Trusted local mode by default.** With no `CRUCIBLE_ADMIN_TOKEN`, the server binds to `127.0.0.1` and skips auth, which makes `crucible serve` feel like a local dev tool. Set the token (and bind to `0.0.0.0`) to run it for a team; project API keys (`cru_…`) then scope gateway and ingest traffic to one project.

## Request flow examples

**Eval run.** `loadEvalSpec` materializes dataset, prompt version and eval rows. `runEval` fans items across workers; each item renders the prompt template, starts a trace, calls the gateway, ends the trace, scores the output with every configured scorer, and stores an `eval_results` row with the trace id. On completion it summarizes and, if a baseline is set, computes per-item regressions.

**Gateway request.** Auth middleware resolves the API key to a project. `Gateway.chat` checks rate limit and budgets, resolves the model (route alias, `provider/model` pin, or bare model), optionally redacts, checks the cache, then walks the targets with per-target retries, recording a `gateway_requests` row for every attempt (so fallback depth and upstream errors are visible in the UI).

**Fork from the UI.** The run page posts `atSeq` plus an optional `replaceEvent`. If the agent is registered on the server, the runtime starts a new run in fork mode; the UI subscribes to the run's SSE stream and renders events as they arrive; the diff tab then compares the two event logs.
