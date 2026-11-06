# Research brief: open-core, all-in-one AI engineering platform

*Compiled 2026-11-05 from a fan-out web research run: 5 search angles, 23 sources fetched, 100 claims extracted, 25 claims put through three-vote adversarial verification (22 confirmed, 3 refuted). Confidence labels below follow that process. Claims marked **extracted, not verified** come from fetched sources but did not go through the vote; treat them as leads.*

## Headline conclusions

1. **Deterministic agent replay plus regression suites from recorded runs is a real, largely unfilled gap.** The market leader's "time travel" (LangGraph) is checkpoint-based and explicitly non-deterministic: everything after the chosen checkpoint re-executes, including LLM calls. The only record-and-stub implementation found is a three-star single-author package. Crucible's event-log replay and fork is positioned exactly in this gap. *(high confidence)*
2. **Open-core observability is a validated model, and the bar just went up.** ClickHouse acquired Langfuse (January 16, 2026) and kept the core MIT. Arize raised a $70M Series C in February 2025 on a Phoenix-plus-paid-platform model. Expect the MIT competitor to get cheaper and more scalable, not less. *(high confidence)*
3. **Build on the OpenTelemetry GenAI attribute names, but version-gate the ingest schema.** The conventions have moved to a dedicated repository with zero tagged releases and a `TODO` schema URL. Message content is Opt-In everywhere in the spec, so a debugger cannot rely on default OTel traces and must own content capture and its governance. *(high confidence)*
4. **The paid line in open-core eval tooling is predictable: shared database, multi-replica job queue, auth/SSO, RBAC, multi-team.** Promptfoo's OSS server is single-SQLite, single-replica, no auth, and documented as "not recommended for production"; Langfuse gates RBAC, audit logs, SCIM and retention behind `ee/`. *(high confidence)*
5. **The addressable market is real but small and fast-growing.** Publisher estimates put AI observability at about $1.8B in 2026 growing about 23 percent a year, and LLMOps software at about $7.1B in 2026 growing about 22 percent a year. Methodologies are not public, so treat these as directional. *(medium confidence: figures verified on publisher pages, methods unverified)*
6. **LLM-judge design has converged on a few practices worth copying:** a boolean pass plus a 0-1 score plus an optional threshold; documented biases (verbosity, position, self-preference, authority) with mitigations; calibration against a human-labeled golden set to above 90 percent agreement; cheap deterministic assertions as a preflight before paying for judges. *(high confidence for Promptfoo's guidance; the practices are vendor recommendations, not field standards)*

## A. Competitive landscape

**Verified**

- Langfuse: MIT core (enterprise features in `ee/`), self-hostable at production scale, now owned by ClickHouse. Self-reported at acquisition: 20k+ GitHub stars, 23.1M+ SDK installs per month, 6M+ Docker pulls, 19 of the Fortune 50. Langfuse Cloud continues with unchanged SLAs. Independent registry stats are consistent with the install figures; the Fortune counts are marketing metrics.
- Promptfoo OSS self-hosted server: single local SQLite file, eval jobs in process memory so more than one replica yields "Job not found", no auth/SSO, no teams, no RBAC. Enterprise is a separate image with SAML/OIDC and role-based teams.
- LangGraph Studio: positioned as an agent IDE exposing thread management and time-travel debugging; the operations are "re-run from here" and edit-state-then-fork.

**Extracted, not verified** (from comparison blogs dated 2026; pricing changes often)

- Free tiers: Langfuse Cloud 50k observations/month; LangSmith 5k traces/month; Arize AX cloud 25k spans for one user (Phoenix unlimited self-host); Braintrust 1M spans plus 10k eval runs/month.
- Paid tiers: Langfuse Core $29/month for 100k units then $8 per 100k; LangSmith Plus $39 per seat per month with 10k base traces; Braintrust Pro $249/month; Langfuse Enterprise from $2,499/month.
- Self-hosting: Langfuse and Phoenix can run fully inside a VPC; LangSmith self-hosting is Enterprise-only; Braintrust is cloud-only. Phoenix is Elastic License 2.0, which forbids reselling it as a hosted service.
- Recurring complaints: Langfuse requires users to build their own eval orchestration (regression suites, CI gates, drift alerts) and its self-hosting needs Postgres, ClickHouse, Redis and Kubernetes; LangSmith feels bolted on for teams using raw provider SDKs and bills every invited user as a seat; Braintrust's gigabytes-plus-scores billing is hard to forecast; LiteLLM gates SSO, RBAC and team budgets behind an Enterprise license, supports exact-match caching only, and is reported to have severe tail latency under heavy load (benchmarks cited but not linked in the source).
- Consolidation in 2026: ClickHouse acquired Langfuse, Mintlify acquired Helicone (now in maintenance mode with a frozen roadmap), ServiceNow acquired Traceloop, Cisco plans to fold Galileo into Splunk.
- Gateways: Portkey managed tier $49/month for 100k logs; OpenRouter passes through provider prices and charges a 5.5 percent credit fee, listing 419 models; LiteLLM is the self-operated default with roughly 57k GitHub stars; Bifrost (Go) markets 11 microsecond overhead and ships governance in its open-source tier.
- Tool combinations: teams commonly stitch together an SDK-based tracer (Langfuse or Traceloop) with an eval tool (Braintrust or Promptfoo) and a gateway (LiteLLM), and treat LLM observability as a complement to existing APM rather than a replacement. OpenTelemetry is the common thread.

**Gap this leaves for an all-in-one tool.** The combination users assemble by hand is tracing plus evals plus gateway. Nobody in the list ships eval orchestration, agent replay and gateway governance in one local-first package. The differentiator is the joins: an eval result linked to its trace, a run linked to the gateway requests that priced it, an approval linked to an exact event in a run.

## B. Architecture and standards

**Verified**

- OTel GenAI conventions moved out of the core semantic-conventions repository into `open-telemetry/semantic-conventions-genai` (tied to core v1.42.0, mid-2026). The new repository has no tagged release and its README schema URL reads `TODO`. The old opentelemetry.io pages are "moved" stubs.
- Agent spans are split by control-flow owner: `invoke_agent` when an LLM drives control flow through tool calls, `invoke_workflow` when application code does; both INTERNAL. Remote agent services get a CLIENT-kind `invoke_agent` span.
- All message content attributes (`gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`, `gen_ai.tool.definitions`, tool call arguments and results) are Opt-In. Instrumentations "SHOULD NOT capture them by default". The opt-in switch is per library.

**Extracted, not verified**

- Version history: v1.37 replaced `gen_ai.system` with `gen_ai.provider.name` and moved from per-message events to aggregated attributes; v1.39 added MCP conventions (`mcp.method.name`, `mcp.session.id`, `mcp.protocol.version`, W3C trace context so MCP server spans nest under the agent span); v1.40 added retrieval spans and cache token attributes; v1.41 added reasoning tokens, `invoke_workflow` and streaming metrics.
- A GenAI inference span has exactly two Required attributes: `gen_ai.operation.name` and `gen_ai.provider.name`. Span names should be `{operation} {model}` and `invoke_agent {agent name}`.
- Emitting the latest shapes requires `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental`; there is no dual-emit value and no stable value yet.
- Datadog was among the first commercial backends to support v1.37+ natively; OpenLLMetry still emits a pre-convention shape.
- Gateway caveat from a comparison guide: "OpenAI-compatible" does not guarantee identical behavior across models or response fields; pilot with real traffic.

**Implications already reflected in Crucible.** Span kinds use the OTel vocabulary (`llm`, `tool`, `retriever`, `embedding`, `agent`, `chain`). Content is captured by default because it is a debugging tool, with gateway-level redaction as the control. The OTLP receiver on `/v1/traces` (JSON and protobuf) maps `gen_ai.*` attributes to the span table, accepts both current and pre-v1.37 attribute names, and stores the scope schema URL per span so renames do not break history.

## C. Market and positioning

**Verified**

- ClickHouse acquired Langfuse on January 16, 2026, after PeerDB and HyperDX; terms undisclosed. Rationale given: LLM observability needs high-volume writes plus fast analytical queries, and Langfuse already ran on ClickHouse. ClickHouse describes the AI observability market as fragmented with "dozens of players".
- Arize AI raised a $70M Series C on February 20, 2025, led by Adams Street Partners with Datadog, PagerDuty and Microsoft's M12 participating. Later category rounds are larger (Braintrust $80M Series B February 2026; Dash0 $110M Series B March 2026; Coralogix $200M Series F June 2026), so "largest ever" is time-bound.

**Extracted, not verified**

- LangChain raised $125M at a $1.25B valuation in October 2025. Braintrust's $80M Series B was led by ICONIQ. Braintrust now ships a free gateway in public preview and a "Loop" agent that runs evals and iterates on prompts.
- Arize bundles an AI copilot with more than 50 skills (debugging agent traces, writing evals, optimizing prompts), which signals that competitors are folding AI-assisted debugging into observability products.
- Example monthly cost at 50k runs with 20 spans each and a judge on 10 percent: roughly $105 on Langfuse Core, $249 on Braintrust Pro, $408 on LangSmith Plus with five seats. The cheapest option flips with seat count and payload size.

**Market size (checked against the publishers' own pages on 2026-11-06).** Three commercial estimates, with different scopes, give a consistent order of magnitude:

| Publisher | Scope | 2025 | 2026 | Forecast | Published |
| --- | --- | --- | --- | --- | --- |
| The Business Research Company (also resold by Research and Markets) | "LLMOps software", factory-gate values | $5.88B | $7.14B | $15.59B by 2030, 21.6% CAGR | Sep 2026 on TBRC; Mar 2026 on the Research and Markets listing, same figures |
| Meticulous Research | "AI observability": LLM and agent tracing, prompt logging, offline/online evaluation, quality scoring, drift, guardrails, cost monitoring, GPU infra observability | $1.25B | $1.78B | $13.88B by 2036, 22.8% CAGR | Sep 2026 |
| Meticulous Research | "MLOps & LLMOps platforms", excluding compute, model fees, vector databases, labeling | $6.10B | $7.99B | $52.29B by 2036, 20.7% CAGR | Sep 2026 |

Methodology is the weak point. None of the public pages states a top-down or bottom-up method or its data sources. Meticulous says its figures draw on primary interviews with AI engineering leaders, platform teams and governance leads; the methodology chapter itself is behind the paywall. Treat these as commercial estimates, not audited data. The closest market to Crucible's scope is Meticulous's AI observability definition (about $1.8B in 2026, growing roughly 23 percent a year).

**Not verified.** A widely repeated Gartner prediction about LLM observability adoption by 2028 appears in two conflicting forms (50 percent of GenAI deployments vs 40 percent of organisations); the article carrying it could not be fetched and no gartner.com source was found, so it is excluded. Buyer-persona data comes only from the Futurum survey listed under leads below.

**Positioning takeaways.** Pricing models are a recurring complaint (per-unit, per-seat, per-gigabyte all draw criticism). A flat, predictable self-hosted core with paid tiers only for team features aligns with where the market is already drawing the line. The database-vendor-backed MIT competitor means the free tier must be excellent; the paid tier must sell things Langfuse does not do (agent replay, gateway governance, eval CI gates in one place), not just hosting.

## D. Agent debugging and replay

**Verified**

- LangGraph time travel offers Replay (retry from a prior checkpoint) and Fork (branch from a prior checkpoint with modified state via `update_state`, which creates a new branching checkpoint and preserves history). It is not deterministic: nodes after the checkpoint re-execute, "LLM calls, API requests, and interrupts fire again and may return different results." Human-in-the-loop interrupts are always re-triggered. Subgraphs are a single super-step unless given their own checkpointer.
- `langgraph-replay` (PyPI, MIT, v0.1.1, May 2026) demonstrates the record-and-stub technique: a callback handler records every step's I/O to SQLite; replay substitutes a stub LLM that returns recorded responses by sequential index and a stub toolkit keyed by tool name; a "regression" mode runs a live LLM against recorded tool outputs and emits a divergence report showing where routing changed. Caveats: 3 stars, ~16 downloads per month, matches by call order rather than input, tightly coupled to LangGraph. Evidence of a technique and a gap, not a competitor.

**Extracted, not verified**

- Temporal's position: determinism applies to workflow code only; LLM calls and tools run as Activities; on crash the workflow replays from event history without re-invoking the LLM for decisions already made. OpenAI's Codex web agent and Replit Agent 3 are built on Temporal. This is durable execution for recovery, not a debugging replay with forking.
- AgentOps uses a proprietary event model rather than OpenTelemetry.

**What remains unsolved** (synthesis, not sourced): replay across frameworks rather than per-framework plugins; turning a recorded run into a regression test with tolerance for benign non-determinism; replaying human approvals rather than re-prompting for them. Crucible's runtime now does input-matched record-and-stub (recorded responses are reused only while request hashes match, then execution goes live and the divergence point is recorded) with replayed approvals skipped, and external agents can push event logs through the run-ingest endpoint; tolerance-aware regression suites are the open step.

## Eval design references (verified)

- Promptfoo judge contract: boolean `pass` plus 0-1 `score`, optional `threshold`; both must hold when a threshold is set. Binary for release gates, graduated for trends.
- Four judge biases with mitigations: verbosity (penalize length in rubric), position (randomize order in pairwise), self-preference (use a different judge model than the system under test), authority (focus rubric on content not style).
- Calibrate against a 30-50 example human-labeled golden set until agreement exceeds 90 percent on a holdout, pin the grader model version, rerun the holdout weekly in CI and alert if the mean shifts more than 0.1.
- Run deterministic assertions as a preflight so judges are not paid for on invalid outputs; reserve expensive judges for failures or high-risk rows.
- Treat the candidate output as untrusted input to the judge; delimiters are not a security boundary.

**Extracted, not verified.** Hamel Husain's "critique shadowing": a single domain expert labels pass/fail with reusable critiques, reach above 90 percent agreement in about three iterations, report true positive and true negative rates rather than raw agreement, and collect roughly 100 examples per failure mode. An EMNLP 2026 Findings paper documents position bias in rubric-based judging whose direction is model-specific; permuting rubric option order attenuates it.

**Crucible mapping.** The `llm_judge` scorer returns a normalized score plus a pass flag with a threshold. Implemented from this research: deterministic scorers run before judges and `runIf: "preflight_passed"` skips the judge when they fail; evals warn when the judge model equals the model under test or when a judge has no pass threshold; `crucible eval calibrate` scores a human-labelled golden set and reports agreement, true-positive and true-negative rates, Cohen's kappa and every disagreement with critiques. Not implemented: rubric option permutation (Crucible's judge asks for a numeric score rather than a multiple-choice rubric, so the position bias the EMNLP paper describes applies less directly).

## Refuted claims (do not reuse)

- "Only `error.type` is Stable among OTel agent-span attributes." The stability picture is more nuanced; the blanket statement was voted down 0-3.
- "Phoenix had 2M+ monthly downloads as of February 2025." Vendor figure, internally inconsistent across Arize posts, and current registry data is far lower; also, Phoenix is Elastic License, not plain OSS.
- "langgraph-replay shows local-first SQLite agent recording is an established pattern." It is one tiny package; it demonstrates a technique, not an established pattern.

## Follow-up run (2026-11-06)

*A second research run targeted the gaps above: 23 sources fetched, 108 claims extracted, 25 put through three-vote verification (22 confirmed, 3 refuted). Market sizing and OTel adoption claims were fetched but none reached the verification budget, so they appear below as leads only.*

### Verified

**Competitors, pricing and openness** *(pages fetched 2026-11-05/06; pricing changes often)*

| Product | Open source | Self-hosting | Hosted pricing | Notes |
| --- | --- | --- | --- | --- |
| LangSmith | No license claim | Enterprise add-on only | Developer $0, Plus $39/seat (re-check before quoting; a detailed tier claim was refuted 1-2) | Cloud-first, US or EU |
| Braintrust | SDKs, autoevals, proxy, Terraform only. UI, API and Brainstore are closed | Data plane only, control plane stays hosted. Closed to new customers from 2026-11-04 | Starter $0; Pro $249/mo; Enterprise custom. Billed per GB processed plus per score | Moving away from customer-controlled deployment |
| Portkey | Gateway is MIT (~13k stars) | Gateway only: routing, retries, fallbacks, guardrails, basic dashboard | Developer free (10k logs, "not suitable for production"); Production $49/mo for 100k logs | Acquired by Palo Alto Networks, closed 2026-05-29 (~$117-140M per SEC filings); now Prisma AIRS AI Gateway |
| LiteLLM | MIT gateway with virtual keys, budgets, rate limits, spend tracking, admin UI, guardrails and an MCP gateway | Same image; Enterprise is a license key | Not published | Enterprise adds SSO beyond 5 users, SCIM, audit logs, org admins, secret managers, IP allowlists |
| Opik (Comet) | Apache-2.0, same codebase as hosted | Docker Compose or Helm, unlimited spans | Free (25k spans); Pro $19/mo flat (100k spans); Enterprise custom | Auth, RBAC and SSO are Enterprise-only; an open GitHub issue asks how to secure self-hosted |
| W&B Weave | Not stated | Enterprise only; self-managed in private preview | Now sold under CoreWeave Forge (launched 2026-09-30): Free 1 GB/mo; Pro from $60/mo, then $0.10/MB | Pro limited to teams under 50 employees |

**Replay in production tools.**
- **Laminar** is the closest shipped equivalent of Crucible's replay. A rerun against a recorded trace serves cached LLM responses keyed by trace ID plus a hash of the span input, until the first cache miss or a chosen boundary, then continues live. Limits: LLM responses only (no tool stubs), a fixed set of SDKs, and the cache lives in Laminar's backend.
- **Temporal** (OpenAI Agents SDK integration) records model calls as Activities so they are not re-run on Workflow replay. This is durability, not a debugging workflow. Function tools are replay-safe only when wrapped as Activities. A claim that Temporal has no debugging or forking features was refuted 0-3, so treat that as unknown rather than absent.

**Tool combinations.** Promptfoo resolves Langfuse-managed prompts natively (`langfuse://name@label`). Langfuse's own migration guide says teams leave Promptfoo because eval results live apart from production traces, and that Promptfoo's red-teaming has no Langfuse equivalent. This is vendor positioning, not adoption data. *(medium confidence)*

### Extracted, not verified (leads)

- **Market and funding.** A funding tracker (Bot Memo) counts $6.02B raised by "AI in production" software startups in January-September 2026, against $1.70B for all of 2025, with inference platforms taking 92 percent. Evaluation and observability raised $272M (Braintrust $80M, Patronus $50M, Judgment Labs $32M, Fiddler $30M, Coval $28M and smaller rounds). Gateways raised $129M (OpenRouter $113M Series B, Portkey $15M Series A).
- **Acquisitions.** Dynatrace agreeing to acquire Arize for a reported $915M (August 2026); Cisco acquiring Galileo into Splunk (announced April 2026, price undisclosed); Humanloop's team joining Anthropic with the platform shut down (August 2025); Helicone to Mintlify (March 2026). Only the Portkey deal is verified here.
- **Buyers.** Futurum's 2H 2026 survey (839 decision makers): 64 percent plan to raise observability spend but only 19 percent by more than 15 percent; 75 percent had a production incident involving AI code, agents or tools; only 32 percent cap spend per agent or session and only 12 percent evaluate agent work before promotion. Futurum expects buyers to judge AI observability on "cost per accepted result" by end of 2027.
- **Standards.** *(Release state now verified, see below.)* Datadog supports the GenAI conventions natively; Langfuse accepts them over OTLP; Phoenix's native schema remains OpenInference; OpenLLMetry still emits the deprecated `gen_ai.prompt`/`gen_ai.completion`. An OTel Collector `gen_ai_normalizer` processor converts OpenInference and OpenLLMetry shapes to the official conventions. LiteLLM's OTel v2 exporter emits `gen_ai.*` spans (including MCP `execute_tool` spans with `mcp.method.name`) but is opt-in via `LITELLM_OTEL_V2=true`.
- **Stitched-stack friction.** Langfuse Cloud retires the SDK v2 ingestion route on 2026-11-16, breaking LiteLLM's native Langfuse callback (pinned below v3) and pushing that stack onto OTLP. The LiteLLM-to-Langfuse pipeline has four bounded queues that drop rather than block, so traces are best-effort, not an audit log. Practitioner reports describe LiteLLM memory growth under high concurrency, key rotation not taking effect on config reload, default retries that multiply spend, and fallbacks that are sequential rather than cost-sorted. A July 2026 benchmark measured 257.7 ms of added p99 latency for LiteLLM's Python proxy.
- **Replay research.** Chronicle (arXiv 2609.20625, September 2026) introduces "cut-point replay": serve a chosen subset of boundaries from the recording and run the rest live against new code, turning a recorded incident into a CI regression test. In its mutation study, cut-point tests caught every mutant that let a recorded unsafe action through, while stubbing every boundary caught none. Chronicle matches boundaries by name and call count, not by input.

### Verified directly against the repository (2026-11-06)

`open-telemetry/semantic-conventions-genai` has **no git tags and no releases**; its README schema URL still reads `TODO`; and all 281 `stability:` markers in its model files are `development`, none `stable` or `release_candidate`. The latest commit on main is dated 2026-11-06, so the repository is active. The OpenTelemetry project's own GenAI blog post describes the conventions as "already in use today and under active development" and names VS Code Copilot (traces, metrics, events), OpenAI Codex (log events and metrics) and Claude Code (metrics and logs, traces in beta) as emitters. Which instrumentation libraries emit which convention version remains unverified beyond the leads above.

### What changed in Crucible as a result

- **Cut-point replay** (`replayBoundaries`): replay and fork can now serve only model responses from the recording and execute tools live with the current code, or the reverse. This is the mode that catches tool-guard regressions, per Chronicle's mutation result. Crucible combines it with input-matched stubbing, which neither Laminar (LLM only) nor Chronicle (order-matched) does. Exposed as `--replay llm|tool` on the CLI, `replayBoundaries` on the fork and replay APIs, and a "Replay, tools live" action on the run page.
- **Positioning check.** Every verified competitor gates SSO, RBAC or audit logs behind Enterprise, and two of six (Braintrust, Weave) are restricting self-hosting. Crucible's audit log, approvals and Postgres backend are in the open core; SSO and RBAC remain the natural paid boundary.

## Open questions for a follow-up run

1. Verified pricing and openness for Helicone, OpenRouter, AgentOps, Phoenix, Bifrost/Maxim, Dash0 and Traceloop (the follow-up run covered LangSmith, Braintrust, Portkey, LiteLLM, Opik and Weave).
2. Whether Inspect AI, AgentOps, LangSmith, Braintrust, Restate, DBOS or Inngest stub tool calls during replay or build regression suites from recorded runs, and what Temporal offers for debugging.
3. The methodology behind the commercial market estimates (paywalled), the original Gartner source, and verification of the Arize, Galileo and funding-tracker figures listed as leads above.
4. Verified adoption of the OTel GenAI conventions by version across OpenLLMetry, OpenInference, Vercel AI SDK, Logfire and New Relic. (Release state of the conventions repository is now verified: no release.)
5. Independent evidence (surveys, issues, forum threads) of which tool combinations teams actually run, beyond vendor migration guides.

## Sources

Market size (publisher pages): thebusinessresearchcompany.com LLMOps software report; researchandmarkets.com report 6231287; meticulousresearch.com AI observability (6879) and MLOps & LLMOps platforms (6912). OTel: github.com/open-telemetry/semantic-conventions-genai (tags, README, model files, read 2026-11-06); opentelemetry.io/blog/2026/genai-observability. Follow-up competitor sources: langchain.com/pricing; braintrust.dev/pricing and docs; portkey.ai/pricing; docs.litellm.ai/docs/enterprise; comet.com/site/pricing; coreweave.com/forge-pricing; laminar.sh/docs/debugger; docs.temporal.io OpenAI Agents integration; langfuse.com Promptfoo migration guide; arXiv 2609.20625 (Chronicle).

First run, primary: opentelemetry.io gen-ai agent spans (stub) and `open-telemetry/semantic-conventions-genai`; clickhouse.com acquisition post and langfuse.com joining post; arize.com Series C post and adamsstreetpartners.com; docs.langchain.com time travel, persistence and Studio pages; pypi.org `langgraph-replay`; promptfoo.dev judge guide, llm-rubric, self-hosting and enterprise pages; arxiv.org 2602.02219.
Secondary and blogs: dash0.com and greptime.com on OTel GenAI; dev.to comparisons (gabrielanhaia, grepture, mr_manushukla, kuldeep_paul); agentopsguide.com; roadmap.sh observability tools; pkgpulse.com gateway comparison; temporal.io agents post; hamel.dev LLM judge post.
