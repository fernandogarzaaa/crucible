# Crucible

**An open-core, all-in-one AI engineering platform.** One local-first binary that gives you:

| Module | What it does |
| --- | --- |
| **Workbench** | Versioned prompts with labels (`support-reply@production`), datasets, a playground with side-by-side model comparison |
| **Evals** | Assertion, similarity, JSON-schema, latency, cost and LLM-as-judge scorers. Declarative spec files for CI. Baseline comparison with per-item regression detection. Judges can be gated on deterministic preflight checks, and `crucible eval calibrate` measures a judge against human labels (agreement, true-positive/negative rates, Cohen's kappa, disagreements) |
| **Tracing** | Traces and spans aligned with the OpenTelemetry GenAI conventions (llm / tool / retriever / agent), waterfall view, cost and token accounting, a zero-dependency SDK, and an OTLP/HTTP receiver so any OpenTelemetry SDK can export straight to Crucible |
| **Agent debugger** | Every agent run is an ordered event log. **Replay** deterministically, **fork** from any step with a patched tool result or a different model, **diff** two runs, **kill** a runaway run. Recorded responses are matched by request input, so a fork after a prompt change replays only the unaffected prefix and reports where it diverged |
| **Gateway** | OpenAI-compatible `/v1/chat/completions` and Anthropic-compatible `/v1/messages` in front of Anthropic, OpenAI, Ollama, Groq, OpenRouter. Routes with fallback / round-robin / cheapest / weighted strategies, response caching, PII redaction, per-key rate limits, hard-stop budgets, full request log |
| **Knowledge (RAG)** | Chunking, embeddings, hybrid BM25 + vector retrieval with reciprocal rank fusion, optional LLM rerank, a query inspector, and retrieval evals (recall@k, MRR) |
| **Operations** | Fleet health per agent, human-in-the-loop approvals for sensitive tools, alert rules, budgets, API keys, and an audit log of every operator action |

Everything runs on Node 22+ with **zero native dependencies**: storage is SQLite via `node:sqlite` by default, or Postgres for teams (`CRUCIBLE_DATABASE_URL=postgres://…`), the server is Hono, the UI is React. `pnpm install && pnpm build && pnpm dev` and you have the whole platform at `http://localhost:4800`.

## Quick start

```bash
pnpm install
pnpm build
cp .env.example .env          # add ANTHROPIC_API_KEY / OPENAI_API_KEY (optional: a scripted demo model works offline)
node apps/cli/dist/index.js init
node apps/cli/dist/index.js serve
```

Open http://localhost:4800. Then, from another terminal:

```bash
# Run an eval from a spec file (also what you run in CI)
node apps/cli/dist/index.js eval run evals/example.eval.json --fail-on-regression

# Use the gateway from any OpenAI or Anthropic SDK by changing the base URL
curl localhost:4800/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"smart","messages":[{"role":"user","content":"hello"}]}'

# Run, replay and fork a demo agent
node apps/cli/dist/index.js agent run researcher "What does a hard-stop budget do?"
node apps/cli/dist/index.js agent runs
node apps/cli/dist/index.js agent fork <runId> 4 --patch '{"content":"a different tool result"}'
```

`pnpm link --global apps/cli` (or `npm i -g ./apps/cli` after publishing) gives you a global `crucible` command.

## Repository layout

```
packages/core      Domain schema (zod), SQLite store, repositories, pricing table
packages/gateway   Providers (Anthropic, OpenAI-compatible, scripted mock), router, cache, redaction, rate limits, budgets
packages/evals     Scorers, eval runner, declarative spec loader
packages/agents    Agent runtime with record / replay / fork / approvals / kill, run diffing
packages/rag       Chunker, ingestion pipeline, hybrid retrieval, retrieval evals
packages/sdk       Instrumentation client for your own apps (@crucible/sdk)
apps/server        Hono API + OpenAI/Anthropic compatibility layer + SSE live feeds, serves the web UI
apps/web           React dashboard (Vite)
apps/cli           `crucible` command line
examples/          Instrumenting an app with the SDK, defining custom agents
```

## Instrumenting your app

```ts
import { Crucible } from "@crucible/sdk";
const crucible = new Crucible({ baseUrl: "http://localhost:4800", project: "default" });

const answer = await crucible.traced("support-reply", async (t) => {
  const { messages } = await crucible.prompt("support-reply@production", { ticket });
  return crucible.withSpan(t, "llm", "llm", async (span) => {
    const res = await crucible.chat({ messages, config: { model: "smart" } });   // goes through the gateway
    span.setUsage(res.usage, res.model);
    return res.message.content;
  });
}, { sessionId: ticket.id, tags: ["support"] });
```

See `examples/instrument.mjs` for a runnable version.

## Defining your own agents

Create `crucible.agents.mjs` next to where you run the server:

```js
export default (ctx) => [{
  name: "support-triage",
  system: "Triage support tickets. Escalate billing issues.",
  model: { model: "smart" },
  maxSteps: 6, maxCostUsd: 0.5,
  tools: [{
    name: "escalate", description: "Escalate a ticket to a human",
    inputSchema: { type: "object", properties: { ticketId: { type: "string" } }, required: ["ticketId"] },
    requiresApproval: true,                         // pauses the run until approved in the UI / CLI
    handler: async ({ ticketId }) => `escalated ${ticketId}`,
  }],
}];
```

Registered agents can be run, replayed and forked live from the UI and the CLI. Agents built with other frameworks can still push their event logs through `POST /api/projects/:p/runs/ingest` and get the same timeline, diff and event-level forking.

## Calibrating an LLM judge

Judges drift and carry biases (verbosity, position, self-preference). Before using one as a release gate, score a human-labelled golden set with it. Items carry the candidate response under `metadata.output` and the human verdict in `expected` (`true`/`false`, `"pass"`/`"fail"`, or `{ "pass": false, "critique": "..." }`).

```bash
crucible dataset import golden golden.json
crucible eval calibrate golden --judge '{"model":"smart","rubric":"Is the answer factually correct?","scale":[1,5],"passThreshold":4}'
```

The report lists every disagreement with the judge's reason next to the human critique, so the rubric can be refined until agreement exceeds 90 percent. Evals also warn when the judge model equals the model under test, and `"runIf": "preflight_passed"` on an `llm_judge` scorer skips the judge (and its cost) when deterministic scorers already failed.

## Sending OpenTelemetry traces

Crucible accepts OTLP/HTTP JSON on `/v1/traces` and maps `gen_ai.*` attributes (operation name, model, provider, token usage, opt-in message content, tool arguments) onto its span model, storing the scope schema URL on each span so attribute renames across convention versions do not break history.

```bash
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:4800/v1/traces
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
export OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true   # content is opt-in in the OTel spec
```

Both `application/json` and `application/x-protobuf` (the SDK default) are accepted, optionally gzip-encoded; the protobuf path uses a small built-in decoder with no protobuf runtime dependency.

## Evals in CI

`evals/example.eval.json` is a declarative spec: a dataset (inline or by name), a prompt (by reference or inline), scorers, and `"baseline": "latest"`. `crucible eval run spec.json --fail-on-regression` exits non-zero on errors or per-item regressions against the previous completed run. `.github/workflows/evals.yml` shows the CI wiring.

## Gateway routes

```json
{ "routes": [
  { "name": "smart", "strategy": "fallback", "targets": [{ "provider": "anthropic", "model": "claude-sonnet-5-5" }, { "provider": "openai", "model": "gpt-4.1" }] },
  { "name": "fast",  "strategy": "cheapest", "cacheTtlSeconds": 300, "redact": true, "targets": [{ "provider": "anthropic", "model": "claude-haiku-5-5" }, { "provider": "openai", "model": "gpt-4.1-mini" }] }
], "defaultRoute": "smart" }
```

Clients send `model: "smart"`. Pin a provider with `anthropic/claude-haiku-5-5`. Budgets are scoped to `project`, `key:<id>`, `agent:<name>` or `model:<id>` and return HTTP 402 when a hard-stop limit is hit.

## Configuration

| Variable | Purpose |
| --- | --- |
| `CRUCIBLE_HOME` | Data directory (default `./.crucible`) |
| `CRUCIBLE_DATABASE_URL` | `postgres://user:pass@host/db` for a shared team database, or `pglite://./dir` for embedded Postgres. Unset = SQLite in `CRUCIBLE_HOME` |
| `CRUCIBLE_PORT`, `CRUCIBLE_HOST` | Server bind (default `127.0.0.1:4800`) |
| `CRUCIBLE_ADMIN_TOKEN` | When set, every `/api` call needs this bearer token (or a project API key). Unset = trusted local mode |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `OLLAMA_BASE_URL` | Providers to enable |
| `CRUCIBLE_CACHE_TTL` | Default response cache TTL in seconds (0 = off) |
| `CRUCIBLE_RATE_LIMIT` | Requests per minute per API key |
| `CRUCIBLE_REDACT` | `1` to redact PII on every request by default |
| `CRUCIBLE_AGENTS` | Path to a custom agents module (default `crucible.agents.mjs`) |

## Open-core boundary (proposed)

Everything in this repository is Apache-2.0, including the Postgres backend. The intended paid tier layers on top without forking the core: SSO and RBAC, multi-tenant management, managed cloud, long-term retention, SOC 2 controls, SLAs. The `Db` interface in `packages/core` is the seam: `SqliteDb` and `PostgresDb` implement the same synchronous surface, so every repository is backend-agnostic. The Postgres driver runs in a worker thread behind a synchronous bridge; the test suite runs every store and server test against both backends (Postgres via PGlite, in process).

## Development

```bash
pnpm test          # vitest across all packages; store/server suites run on SQLite and embedded Postgres (PGlite)
CRUCIBLE_TEST_PG_URL=postgres://user@localhost:5432/crucible pnpm test   # also runs the real-Postgres suites (CI does this with a service container)
pnpm typecheck
pnpm --filter @crucible/web dev     # Vite dev server on :4801 proxying to the API on :4800
```
