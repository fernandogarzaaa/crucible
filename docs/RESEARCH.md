# Research brief: open-core, all-in-one AI engineering platform

*Compiled 2026-11-05 from a fan-out web research run: 5 search angles, 23 sources fetched, 100 claims extracted, 25 claims put through three-vote adversarial verification (22 confirmed, 3 refuted). Confidence labels below follow that process. Claims marked **extracted, not verified** come from fetched sources but did not go through the vote; treat them as leads.*

## Headline conclusions

1. **Deterministic agent replay plus regression suites from recorded runs is a real, largely unfilled gap.** The market leader's "time travel" (LangGraph) is checkpoint-based and explicitly non-deterministic: everything after the chosen checkpoint re-executes, including LLM calls. The only record-and-stub implementation found is a three-star single-author package. Crucible's event-log replay and fork is positioned exactly in this gap. *(high confidence)*
2. **Open-core observability is a validated model, and the bar just went up.** ClickHouse acquired Langfuse (January 16, 2026) and kept the core MIT. Arize raised a $70M Series C in February 2025 on a Phoenix-plus-paid-platform model. Expect the MIT competitor to get cheaper and more scalable, not less. *(high confidence)*
3. **Build on the OpenTelemetry GenAI attribute names, but version-gate the ingest schema.** The conventions have moved to a dedicated repository with zero tagged releases and a `TODO` schema URL. Message content is Opt-In everywhere in the spec, so a debugger cannot rely on default OTel traces and must own content capture and its governance. *(high confidence)*
4. **The paid line in open-core eval tooling is predictable: shared database, multi-replica job queue, auth/SSO, RBAC, multi-team.** Promptfoo's OSS server is single-SQLite, single-replica, no auth, and documented as "not recommended for production"; Langfuse gates RBAC, audit logs, SCIM and retention behind `ee/`. *(high confidence)*
5. **LLM-judge design has converged on a few practices worth copying:** a boolean pass plus a 0-1 score plus an optional threshold; documented biases (verbosity, position, self-preference, authority) with mitigations; calibration against a human-labeled golden set to above 90 percent agreement; cheap deterministic assertions as a preflight before paying for judges. *(high confidence for Promptfoo's guidance; the practices are vendor recommendations, not field standards)*

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

**Implications already reflected in Crucible.** Span kinds use the OTel vocabulary (`llm`, `tool`, `retriever`, `embedding`, `agent`, `chain`). Content is captured by default because it is a debugging tool, with gateway-level redaction as the control. An OTLP ingest endpoint mapping `gen_ai.*` attributes to the span table is the next step, and it should carry a schema version so attribute renames do not break history.

## C. Market and positioning

**Verified**

- ClickHouse acquired Langfuse on January 16, 2026, after PeerDB and HyperDX; terms undisclosed. Rationale given: LLM observability needs high-volume writes plus fast analytical queries, and Langfuse already ran on ClickHouse. ClickHouse describes the AI observability market as fragmented with "dozens of players".
- Arize AI raised a $70M Series C on February 20, 2025, led by Adams Street Partners with Datadog, PagerDuty and Microsoft's M12 participating. Later category rounds are larger (Braintrust $80M Series B February 2026; Dash0 $110M Series B March 2026; Coralogix $200M Series F June 2026), so "largest ever" is time-bound.

**Extracted, not verified**

- LangChain raised $125M at a $1.25B valuation in October 2025. Braintrust's $80M Series B was led by ICONIQ. Braintrust now ships a free gateway in public preview and a "Loop" agent that runs evals and iterates on prompts.
- Arize bundles an AI copilot with more than 50 skills (debugging agent traces, writing evals, optimizing prompts), which signals that competitors are folding AI-assisted debugging into observability products.
- Example monthly cost at 50k runs with 20 spans each and a judge on 10 percent: roughly $105 on Langfuse Core, $249 on Braintrust Pro, $408 on LangSmith Plus with five seats. The cheapest option flips with seat count and payload size.

**Not found.** No credible market-size estimate for LLMOps or AI engineering tooling survived; analyst figures found were low quality. No buyer-persona research survived. Treat these as open.

**Positioning takeaways.** Pricing models are a recurring complaint (per-unit, per-seat, per-gigabyte all draw criticism). A flat, predictable self-hosted core with paid tiers only for team features aligns with where the market is already drawing the line. The database-vendor-backed MIT competitor means the free tier must be excellent; the paid tier must sell things Langfuse does not do (agent replay, gateway governance, eval CI gates in one place), not just hosting.

## D. Agent debugging and replay

**Verified**

- LangGraph time travel offers Replay (retry from a prior checkpoint) and Fork (branch from a prior checkpoint with modified state via `update_state`, which creates a new branching checkpoint and preserves history). It is not deterministic: nodes after the checkpoint re-execute, "LLM calls, API requests, and interrupts fire again and may return different results." Human-in-the-loop interrupts are always re-triggered. Subgraphs are a single super-step unless given their own checkpointer.
- `langgraph-replay` (PyPI, MIT, v0.1.1, May 2026) demonstrates the record-and-stub technique: a callback handler records every step's I/O to SQLite; replay substitutes a stub LLM that returns recorded responses by sequential index and a stub toolkit keyed by tool name; a "regression" mode runs a live LLM against recorded tool outputs and emits a divergence report showing where routing changed. Caveats: 3 stars, ~16 downloads per month, matches by call order rather than input, tightly coupled to LangGraph. Evidence of a technique and a gap, not a competitor.

**Extracted, not verified**

- Temporal's position: determinism applies to workflow code only; LLM calls and tools run as Activities; on crash the workflow replays from event history without re-invoking the LLM for decisions already made. OpenAI's Codex web agent and Replit Agent 3 are built on Temporal. This is durable execution for recovery, not a debugging replay with forking.
- AgentOps uses a proprietary event model rather than OpenTelemetry.

**What remains unsolved** (synthesis, not sourced): input-matched rather than order-matched stubbing so a fork survives small prompt changes; replay across frameworks rather than per-framework plugins; turning a recorded run into a regression test with tolerance for benign non-determinism; replaying human approvals rather than re-prompting for them. Crucible's runtime does order-matched record-and-stub with replayed approvals skipped; input-matched stubbing and cross-framework ingestion via the run-ingest endpoint are the next two steps.

## Eval design references (verified)

- Promptfoo judge contract: boolean `pass` plus 0-1 `score`, optional `threshold`; both must hold when a threshold is set. Binary for release gates, graduated for trends.
- Four judge biases with mitigations: verbosity (penalize length in rubric), position (randomize order in pairwise), self-preference (use a different judge model than the system under test), authority (focus rubric on content not style).
- Calibrate against a 30-50 example human-labeled golden set until agreement exceeds 90 percent on a holdout, pin the grader model version, rerun the holdout weekly in CI and alert if the mean shifts more than 0.1.
- Run deterministic assertions as a preflight so judges are not paid for on invalid outputs; reserve expensive judges for failures or high-risk rows.
- Treat the candidate output as untrusted input to the judge; delimiters are not a security boundary.

**Extracted, not verified.** Hamel Husain's "critique shadowing": a single domain expert labels pass/fail with reusable critiques, reach above 90 percent agreement in about three iterations, report true positive and true negative rates rather than raw agreement, and collect roughly 100 examples per failure mode. An EMNLP 2026 Findings paper documents position bias in rubric-based judging whose direction is model-specific; permuting rubric option order attenuates it.

**Crucible mapping.** The `llm_judge` scorer already returns a normalized score plus a pass flag with a threshold. To do: rubric option permutation, a "judge model must differ from target model" warning, a calibration workflow against a golden dataset, and a preflight ordering so deterministic scorers run before the judge.

## Refuted claims (do not reuse)

- "Only `error.type` is Stable among OTel agent-span attributes." The stability picture is more nuanced; the blanket statement was voted down 0-3.
- "Phoenix had 2M+ monthly downloads as of February 2025." Vendor figure, internally inconsistent across Arize posts, and current registry data is far lower; also, Phoenix is Elastic License, not plain OSS.
- "langgraph-replay shows local-first SQLite agent recording is an established pattern." It is one tiny package; it demonstrates a technique, not an established pattern.

## Open questions for a follow-up run

1. Current pricing, licensing and documented complaints for LangSmith, Braintrust, Helicone, LiteLLM, Portkey, OpenRouter, W&B Weave, Humanloop, AgentOps, Laminar and Opik from primary sources.
2. Whether Inspect AI, AgentOps, Laminar or LangSmith offer input-matched deterministic replay or regression suites from recorded runs.
3. A credible 2025-2026 market-size estimate and the full funding and M&A picture.
4. Actual adoption of the OTel GenAI conventions and MCP across instrumentation libraries and gateways, and the expected date of the first tagged `semantic-conventions-genai` release.

## Sources

Primary: opentelemetry.io gen-ai agent spans (stub) and `open-telemetry/semantic-conventions-genai`; clickhouse.com acquisition post and langfuse.com joining post; arize.com Series C post and adamsstreetpartners.com; docs.langchain.com time travel, persistence and Studio pages; pypi.org `langgraph-replay`; promptfoo.dev judge guide, llm-rubric, self-hosting and enterprise pages; arxiv.org 2602.02219.
Secondary and blogs: dash0.com and greptime.com on OTel GenAI; dev.to comparisons (gabrielanhaia, grepture, mr_manushukla, kuldeep_paul); agentopsguide.com; roadmap.sh observability tools; pkgpulse.com gateway comparison; temporal.io agents post; hamel.dev LLM judge post.
