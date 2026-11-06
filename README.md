# Crucible

**An open-core, all-in-one AI engineering platform.** One local-first binary that gives you:

| Module | What it does |
| --- | --- |
| **Workbench** | Versioned prompts with labels (`support-reply@production`), datasets, a playground with side-by-side model comparison |
| **Evals** | Assertion, similarity, JSON-schema, latency, cost and LLM-as-judge scorers. Declarative spec files for CI. Baseline comparison with per-item regression detection. Judges can be gated on deterministic preflight checks, and `crucible eval calibrate` measures a judge against human labels (agreement, true-positive/negative rates, Cohen's kappa, disagreements) |
| **Tracing** | Traces and spans aligned with the OpenTelemetry GenAI conventions (llm / tool / retriever / agent), waterfall view, cost and token accounting, a zero-dependency SDK, and an OTLP/HTTP receiver so any OpenTelemetry SDK can export straight to Crucible |
| **Agent debugger** | Every agent run is an ordered event log. **Replay** deterministically, **fork** from any step with a patched tool result or a different model, **diff** two runs, **kill** a runaway run. Recorded responses are matched by request input, so a fork after a prompt change replays only the unaffected prefix and reports where it diverged. Cut-point replay serves only model responses from the recording and runs tools live with current code, which catches tool regressions that full stubbing hides |
| **Gateway** | OpenAI-compatible `/v1/chat/completions` and `/v1/responses`, and Anthropic-compatible `/v1/messages`, in front of Anthropic, OpenAI, Ollama, Groq, OpenRouter, and the Claude Code, Codex, OpenCode and Cline CLIs (subscription logins and free models). Routes with fallback / round-robin / cheapest / weighted strategies, response caching, PII redaction, per-key rate limits, hard-stop budgets, full request log |
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
node apps/cli/dist/index.js agent replay <runId> --replay llm    # replay model decisions, run tools live
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

## Subscription logins and free models (wrapped CLIs)

Crucible can drive four coding-agent CLIs as model providers. Each one runs as a subprocess with its own login, so requests are billed to whatever that CLI is signed in with. Crucible never reads, copies or forwards the credentials.

| CLI | Gives you | Sign in | Pin as | Route |
| --- | --- | --- | --- | --- |
| Claude Code (`claude`) | Your Claude Pro/Max subscription | `crucible cli login claude` | `claude-code/sonnet`, `claude-code/opus`, `claude-code/haiku` | `claude-subscription` |
| Codex (`codex`) | Your ChatGPT Plus/Pro subscription | `crucible cli login codex` (add `--device` on a headless machine) | `codex/default` or `codex/<model>` | `codex-subscription` |
| OpenCode (`opencode`) | OpenCode Zen free models, no account | none needed | `opencode/opencode/<model>-free` | `free` |
| Cline (`cline`) | OpenRouter free models (free key), or any provider set up with `cline auth` | set `OPENROUTER_API_KEY`, or `cline auth` | `cline/openrouter/<model>:free` | `free` |

```bash
npm i -g @anthropic-ai/claude-code @openai/codex opencode-ai cline   # whichever you want
crucible cli status        # what is installed and signed in
crucible cli free          # discover today's free models and show the free route
crucible chat claude-subscription "Explain this stack trace: ..."
crucible chat free "Summarise RFC 9110 in three bullets"
```

Any OpenAI or Anthropic SDK pointed at Crucible can use them too, for example `model: "claude-subscription"` or `model: "free"`, with streaming. Details:

- **Isolation.** Each request runs in a fresh, empty scratch directory. Claude Code runs with tools, MCP servers and user settings disabled, and its agent system prompt is replaced. Codex runs read-only and ephemeral. Cline gets a plain-assistant system prompt. These CLIs are agents, so this keeps them answering rather than acting.
- **Subscription, not API billing.** `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are removed from the child environment, because when present those CLIs bill the API instead of the signed-in subscription. Set `CRUCIBLE_CLAUDE_ALLOW_API_KEY=1` or `CRUCIBLE_CODEX_ALLOW_API_KEY=1` to keep them.
- **Opt-in by name.** CLI providers never answer bare model ids and are not part of `smart` or `fast`, so a subscription is only used when a request names it.
- **Free tiers rate-limit.** OpenCode retries rate-limited free models silently. Crucible watches its logs and fails the attempt within seconds with a 429, so the `free` route moves to the next model instead of hanging. The `free` route is rebuilt from live discovery at startup and on `POST /api/gateway/free/refresh`, unless you save your own route named `free`.
- **Limits.** No tool calling or image input on CLI routes; such requests fail with a 400 so a fallback route can move on. Sampling parameters such as temperature are not passed through. Multi-turn conversations are sent as a transcript.
- **Terms.** These routes use your personal subscriptions and free tiers through the vendors' own CLIs. Each vendor's terms apply; in particular, subscriptions are generally for your own use, not for serving other people through a shared gateway.

The Gateway page in the UI has a **CLI providers** tab with the same status and the current free route.

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

Clients send `model: "smart"`. Pin a provider with `anthropic/claude-haiku-5-5`; a pin to a provider that is not configured fails with HTTP 404 `model_not_found` rather than being rerouted. Bare model names no provider claims fall back to `defaultRoute`. Budgets are scoped to `project`, `key:<id>`, `agent:<name>` or `model:<id>` and return HTTP 402 when a hard-stop limit is hit.

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
| `CRUCIBLE_CLI_PROVIDERS` | `off` to stop registering installed CLIs (claude, codex, opencode, cline) as providers |
| `CRUCIBLE_CLI_TIMEOUT_MS`, `CRUCIBLE_CLI_IDLE_MS` | Per-request ceiling (default 10 min) and silence limit (default 90 s) for CLI providers |
| `CRUCIBLE_CLAUDE_BIN`, `CRUCIBLE_CODEX_BIN`, `CRUCIBLE_OPENCODE_BIN`, `CRUCIBLE_CLINE_BIN` | Paths to the CLIs if they are not on `PATH` |
| `CRUCIBLE_OPENCODE_CONFIG`, `CRUCIBLE_CLINE_DATA_DIR` | Alternative OpenCode config file and Cline state directory |
| `CRUCIBLE_FREE_DISCOVERY` | `off` to skip free-model discovery at startup |

## Open-core boundary (proposed)

Everything in this repository is Apache-2.0, including the Postgres backend. The intended paid tier layers on top without forking the core: SSO and RBAC, multi-tenant management, managed cloud, long-term retention, SOC 2 controls, SLAs. The `Db` interface in `packages/core` is the seam: `SqliteDb` and `PostgresDb` implement the same synchronous surface, so every repository is backend-agnostic. The Postgres driver runs in a worker thread behind a synchronous bridge; the test suite runs every store and server test against both backends (Postgres via PGlite, in process).

## Development

```bash
pnpm test          # vitest across all packages; store/server suites run on SQLite and embedded Postgres (PGlite)
CRUCIBLE_TEST_PG_URL=postgres://user@localhost:5432/crucible pnpm test   # also runs the real-Postgres suites (CI does this with a service container)
```

The server suite includes conformance tests that drive Crucible with the unmodified official `@anthropic-ai/sdk` and `openai` clients: plain, streamed and tool-calling requests on Messages, Chat Completions and Responses, embeddings, model listing and error mapping.

CLI providers are unit-tested against event streams recorded from the real CLIs, replayed by a fake binary. `CRUCIBLE_LIVE_CLI=1 pnpm test` also runs the installed Codex, OpenCode and Cline binaries end to end against an in-process Crucible server (no accounts needed), and `CRUCIBLE_LIVE_CLAUDE=1` adds a real call through your Claude Code login. Calls to the real Anthropic and OpenAI APIs are not part of the suite; run the gateway with `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` set to exercise them.

```bash
pnpm typecheck
pnpm --filter @crucible/web dev     # Vite dev server on :4801 proxying to the API on :4800
```
