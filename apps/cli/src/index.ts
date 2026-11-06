#!/usr/bin/env node
import { parseArgs } from "node:util";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { Store } from "@crucible/core";
import { spawn } from "node:child_process";
import { Gateway, LOGIN, MemoryCache, Router, RouterConfig, allCliStatus, buildFreeRoute, cliBinary, discoverFreeModels, providersFromEnv, which, type CliName } from "@crucible/gateway";
import { calibrateJudge, loadEvalSpec, runEval } from "@crucible/evals";
import { AgentRuntime, diffRuns } from "@crucible/agents";
import { RagPipeline } from "@crucible/rag";
import { createContext, refreshFreeModels, startServer } from "@crucible/server";
import { die, fmt, loadDotenv, readJson, table } from "./util.js";

loadDotenv();

const HELP = `crucible <command> [subcommand] [options]

  init                                   Create crucible.config.json, an example eval spec and .env.example
  serve [--port 4800] [--host 127.0.0.1] Start the server + web UI + gateway

  eval run <spec.json> [--fail-on-regression] [--json] [--concurrency N]
  eval list | eval show <evalId>
  eval calibrate <dataset> --judge '<llm_judge json>'   Judge vs human labels: agreement, TP/TN rates, kappa, disagreements

  prompt list | prompt show <name> | prompt push <file.json> | prompt label <name@version> <label>
  dataset list | dataset import <name> <items.json|.jsonl>

  trace list [--limit 20] [--search q] | trace show <traceId>

  agent list | agent run <name> "<input>" | agent replay <runId> | agent fork <runId> <seq> [--patch '<json>'] [--model m] [--match input|order] [--replay llm|tool|llm,tool]
  agent kill <runId> | agent diff <runA> <runB> | agent runs [--status s]
    --replay llm   replays model decisions but runs tools live (catches tool-code regressions)

  rag create <kb> [--chunk 800] [--overlap 100] [--embedding model]
  rag ingest <kb> <dir> | rag query <kb> "<query>" [-k 5] [--mode hybrid|vector|keyword] | rag eval <kb> <cases.json>

  gateway models | gateway routes show | gateway routes set <routes.json> | gateway requests [--limit 50]
  gateway key create <name> | gateway budget set <scope> <usd> <daily|weekly|monthly|total>

  ops approvals | ops approve <id> [--reason r] | ops reject <id> [--reason r] | ops audit | ops overview

  chat <model|route> "<prompt>" [--system s]   One-off call through the gateway, streamed (e.g. chat free "hi")
  cli status                              Wrapped CLIs: installed, signed in, and how to sign in
  cli login <claude|codex|opencode|cline> [--device]   Run the vendor's own login in this terminal
  cli free                                Discover free models (OpenCode Zen, OpenRouter) and show the free route

Global options: --project <slug> (default: default)   --json   --help
Data lives in $CRUCIBLE_HOME (default ./.crucible) or in $CRUCIBLE_DATABASE_URL (postgres://… or pglite://…). Provider keys come from .env / environment.`;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true, strict: false,
  options: {
    project: { type: "string", default: "default" }, json: { type: "boolean", default: false }, help: { type: "boolean", default: false },
    port: { type: "string" }, host: { type: "string" }, "fail-on-regression": { type: "boolean", default: false }, concurrency: { type: "string" },
    limit: { type: "string" }, search: { type: "string" }, status: { type: "string" }, patch: { type: "string" }, model: { type: "string" },
    chunk: { type: "string" }, overlap: { type: "string" }, match: { type: "string" }, judge: { type: "string" }, replay: { type: "string" }, embedding: { type: "string" }, k: { type: "string", short: "k" }, mode: { type: "string" }, reason: { type: "string" },
  },
});
const [cmd, sub, ...rest] = positionals;
const out = (v: unknown) => console.log(flags.json ? JSON.stringify(v, null, 2) : v);

function ctx() {
  const c = createContext({ store: new Store(), discoverFreeModels: false });
  const project = c.store.workbench.getProject(String(flags.project)) ?? die(`project not found: ${flags.project}`);
  return { ...c, project };
}

async function main() {
  if (!cmd || flags.help) { console.log(HELP); return; }
  switch (cmd) {
    case "init": {
      if (!existsSync("crucible.config.json")) writeFileSync("crucible.config.json", JSON.stringify({ project: "default", gateway: { routes: [{ name: "smart", strategy: "fallback", targets: [{ provider: "anthropic", model: "claude-sonnet-5-5" }, { provider: "openai", model: "gpt-4.1" }] }, { name: "fast", strategy: "fallback", cacheTtlSeconds: 300, targets: [{ provider: "anthropic", model: "claude-haiku-5-5" }, { provider: "mock", model: "mock-fast" }] }] } }, null, 2));
      mkdirSync("evals", { recursive: true });
      if (!existsSync("evals/example.eval.json")) writeFileSync("evals/example.eval.json", JSON.stringify({
        name: "example-qa", dataset: { name: "example-qa", items: [{ input: { question: "What is the capital of France?" }, expected: "Paris" }, { input: { question: "What is 2 + 2?" }, expected: "4" }] },
        prompt: { name: "example-qa", model: "fast", template: [{ role: "system", content: "Answer in one word." }, { role: "user", content: "{{question}}" }] },
        scorers: [{ type: "contains" }, { type: "latency", maxMs: 10000 }, { type: "llm_judge", model: "smart", rubric: "Is the answer correct and concise?", scale: [1, 5], passThreshold: 4, runIf: "preflight_passed" }], baseline: "latest",
      }, null, 2));
      if (!existsSync(".env.example")) writeFileSync(".env.example", "ANTHROPIC_API_KEY=\nOPENAI_API_KEY=\nCRUCIBLE_HOME=.crucible\nCRUCIBLE_PORT=4800\n");
      console.log("created crucible.config.json, evals/example.eval.json, .env.example\nnext: crucible serve   |   crucible eval run evals/example.eval.json");
      return;
    }
    case "serve": startServer({ port: flags.port ? Number(flags.port) : undefined, host: flags.host as string | undefined }); return;

    case "eval": {
      const c = ctx();
      if (sub === "run") {
        const spec = readJson(rest[0] ?? die("spec file required"));
        const { evalId } = loadEvalSpec(c.store, { project: c.project.slug, ...(spec as object) });
        let last = 0;
        const report = await runEval({ store: c.store, gateway: c.gateway, evalId, concurrency: flags.concurrency ? Number(flags.concurrency) : 4, onProgress: (p) => { if (!flags.json && p.done !== last) { last = p.done; process.stderr.write(`\r  ${p.done}/${p.total}${p.error ? `  (error: ${p.error.slice(0, 60)})` : ""}`); } } });
        if (!flags.json) process.stderr.write("\n");
        if (flags.json) { out({ evalId, ...report }); }
        else {
          console.log(`\n${report.eval.name}  [${report.eval.status}]  items=${report.summary.items} errors=${report.summary.errors} cost=${fmt.usd(report.summary.costUsd)} avgLatency=${fmt.ms(report.summary.avgLatencyMs)}`);
          console.log(table(Object.entries(report.summary.scores).map(([name, s]) => ({ scorer: name, mean: s.mean.toFixed(3), passRate: fmt.pct(s.passRate), n: s.n }))));
          if (report.eval.baselineEvalId) console.log(`\nvs baseline ${report.eval.baselineEvalId}: ${report.regressions} regressions, ${report.improvements} improvements`);
          for (const w of report.warnings) console.log(`\nwarning: ${w}`);
          console.log(`\neval id: ${evalId}   ${report.passed ? "PASSED" : "FAILED"}`);
        }
        if (flags["fail-on-regression"] && (report.regressions > 0 || report.summary.errors > 0)) process.exit(1);
        return;
      }
      if (sub === "calibrate") {
        const ds = c.store.workbench.getDataset(c.project.id, rest[0] ?? die("dataset name required")) ?? die("dataset not found");
        const judge = flags.judge ? JSON.parse(String(flags.judge)) : die("--judge '<llm_judge json>' required, e.g. --judge '{\"model\":\"fast\",\"rubric\":\"...\",\"scale\":[1,5],\"passThreshold\":4}'");
        const report = await calibrateJudge({ store: c.store, gateway: c.gateway, projectId: c.project.id, datasetId: ds.id, judge: { type: "llm_judge", runIf: "always", scale: [0, 1], ...judge } });
        if (flags.json) return out(report);
        console.log(`n=${report.n}  agreement=${fmt.pct(report.agreement)}  kappa=${report.kappa.toFixed(2)}  TPR=${fmt.pct(report.truePositiveRate)}  TNR=${fmt.pct(report.trueNegativeRate)}  judge cost=${fmt.usd(report.judgeCostUsd)}`);
        console.log(`confusion: tp=${report.confusion.tp} tn=${report.confusion.tn} fp=${report.confusion.fp} fn=${report.confusion.fn}`);
        if (report.disagreements.length) { console.log("\ndisagreements:"); console.log(table(report.disagreements.map((d) => ({ item: d.itemId.slice(-8), human: d.human ? "pass" : "fail", judge: d.judge ? "pass" : "fail", score: d.score, judgeReason: d.reason ?? "", humanCritique: d.critique ?? "", output: d.output.slice(0, 60) })))); }
        console.log("\nadvice:"); for (const a of report.advice) console.log(`- ${a}`);
        return;
      }
      if (sub === "list") return out(flags.json ? c.store.evals.list(c.project.id) : table(c.store.evals.list(c.project.id).map((e) => ({ id: e.id, name: e.name, status: e.status, created: fmt.ago(e.createdAt), passed: (e.summary as { passed?: boolean }).passed ?? "", regressions: (e.summary as { regressions?: number }).regressions ?? "" }))));
      if (sub === "show") { const id = rest[0] ?? die("eval id required"); const e = c.store.evals.get(id) ?? die("not found"); return out({ ...e, summary: c.store.evals.summarize(id), results: c.store.evals.results(id) }); }
      break;
    }
    case "prompt": {
      const c = ctx();
      if (sub === "list") return out(flags.json ? c.store.workbench.listPrompts(c.project.id) : table(c.store.workbench.listPrompts(c.project.id).map((p) => ({ name: p.name, versions: p.versionCount, latest: p.latestVersion, created: fmt.ago(p.createdAt) }))));
      if (sub === "show") { const p = c.store.workbench.getPrompt(c.project.id, rest[0] ?? die("name required")) ?? die("not found"); return out({ ...p, versions: c.store.workbench.listVersions(p.id) }); }
      if (sub === "push") {
        const file = readJson(rest[0] ?? die("file required")) as { name: string; template: never; config: never; commitMessage?: string; labels?: string[] };
        const p = c.store.workbench.getPrompt(c.project.id, file.name) ?? c.store.workbench.createPrompt(c.project.id, file.name);
        const v = c.store.workbench.createVersion(p.id, { template: file.template, config: file.config, commitMessage: file.commitMessage, labels: file.labels });
        return out(flags.json ? v : `pushed ${file.name}@${v.version} (${v.id})`);
      }
      if (sub === "label") { const v = c.store.workbench.resolveVersion(c.project.id, rest[0] ?? die("name@version required")) ?? die("not found"); c.store.workbench.setLabel(v.id, rest[1] ?? die("label required")); return out(`labelled ${rest[0]} as ${rest[1]}`); }
      break;
    }
    case "dataset": {
      const c = ctx();
      if (sub === "list") return out(flags.json ? c.store.workbench.listDatasets(c.project.id) : table(c.store.workbench.listDatasets(c.project.id).map((d) => ({ name: d.name, items: d.itemCount, created: fmt.ago(d.createdAt) }))));
      if (sub === "import") {
        const name = rest[0] ?? die("name required"); const items = readJson(rest[1] ?? die("file required")) as Array<{ input: never; expected?: never }>;
        const ds = c.store.workbench.getDataset(c.project.id, name) ?? c.store.workbench.createDataset(c.project.id, name);
        c.store.workbench.addItems(ds.id, items); return out(`imported ${items.length} items into ${name}`);
      }
      break;
    }
    case "trace": {
      const c = ctx();
      if (sub === "list") return out(flags.json ? c.store.tracing.listTraces({ projectId: c.project.id, limit: Number(flags.limit ?? 20), search: flags.search as string }) : table(c.store.tracing.listTraces({ projectId: c.project.id, limit: Number(flags.limit ?? 20), search: flags.search as string }).map((t) => ({ id: t.id, name: t.name, status: t.status, spans: t.spanCount, tokens: t.totalTokens, cost: fmt.usd(t.costUsd), when: fmt.ago(t.startedAt) }))));
      if (sub === "show") { const t = c.store.tracing.getTrace(rest[0] ?? die("id required")) ?? die("not found"); return out({ ...t, spans: c.store.tracing.listSpans(t.id) }); }
      break;
    }
    case "agent": {
      const c = ctx();
      if (sub === "list") return out(c.agents.list());
      if (sub === "runs") return out(flags.json ? c.store.agents.listRuns(c.project.id, { status: flags.status as never }) : table(c.store.agents.listRuns(c.project.id, { status: flags.status as never }).map((r) => ({ id: r.id, agent: r.agentName, status: r.status, events: r.eventCount, cost: fmt.usd(r.costUsd), parent: r.parentRunId ?? "", when: fmt.ago(r.startedAt) }))));
      const replayB = () => (flags.replay ? (String(flags.replay).split(",").map((x) => x.trim()).filter((x) => x === "llm" || x === "tool") as Array<"llm" | "tool">) : undefined);
      const def = (name: string) => c.agents.get(name) ?? die(`agent not registered: ${name}. Registered: ${c.agents.list().map((a) => a.name).join(", ")}`);
      const tail = (runId: string) => { for (const e of c.store.agents.events(runId)) if (!flags.json) console.log(`  #${e.seq} ${e.type.padEnd(18)} ${JSON.stringify(e.payload).slice(0, 140)}`); };
      if (sub === "run") { const r = await c.runtime.run(def(rest[0] ?? die("agent name required")), { projectId: c.project.id, input: rest[1] ?? die("input required") }); tail(r.run.id); return out(flags.json ? r : `\nrun ${r.run.id} [${r.run.status}] cost=${fmt.usd(r.run.costUsd)}\n${r.output}`); }
      if (sub === "replay") { const src = c.store.agents.getRun(rest[0] ?? die("run id")) ?? die("not found"); const r = await c.runtime.replay(def(src.agentName), src.id, { replayMatch: flags.match as never, replayBoundaries: replayB() }); tail(r.run.id); return out(flags.json ? r : `\nreplayed as ${r.run.id} [${r.run.status}]\n${r.output}`); }
      if (sub === "fork") {
        const src = c.store.agents.getRun(rest[0] ?? die("run id")) ?? die("not found"); const seq = Number(rest[1] ?? die("seq required"));
        const d = def(src.agentName); const effective = flags.model ? { ...d, model: { ...d.model, model: String(flags.model) } } : d;
        const r = await c.runtime.fork(effective, src.id, seq, { replaceEvent: flags.patch ? { seq, payload: JSON.parse(String(flags.patch)) } : undefined, replayMatch: flags.match as never, replayBoundaries: replayB() });
        tail(r.run.id); const diff = diffRuns(c.store, src.id, r.run.id);
        const dv = (r.run.metadata as { divergedAtSeq?: number; divergenceReason?: string }); return out(flags.json ? { run: r, diff } : `\nforked as ${r.run.id} [${r.run.status}] diverged at #${diff.divergedAtSeq}${dv.divergedAtSeq !== undefined ? ` (cassette left at #${dv.divergedAtSeq}: ${dv.divergenceReason})` : ""}\n${r.output}`);
      }
      if (sub === "kill") { c.runtime.kill(rest[0] ?? die("run id"), "cli", flags.reason as string); return out("killed"); }
      if (sub === "diff") return out(diffRuns(c.store, rest[0] ?? die("run a"), rest[1] ?? die("run b")));
      break;
    }
    case "rag": {
      const c = ctx();
      const kb = (name: string) => c.store.rag.getKb(c.project.id, name) ?? die(`knowledge base not found: ${name}`);
      if (sub === "create") return out(c.store.rag.createKb({ projectId: c.project.id, name: rest[0] ?? die("name required"), chunkSize: flags.chunk ? Number(flags.chunk) : undefined, chunkOverlap: flags.overlap ? Number(flags.overlap) : undefined, embeddingModel: flags.embedding as string }));
      if (sub === "list") return out(c.store.rag.listKbs(c.project.id));
      if (sub === "ingest") { const r = await c.rag.ingestDirectory(kb(rest[0] ?? die("kb")), rest[1] ?? die("dir"), { onFile: (f, x) => { if (!flags.json) console.log(`  ${x.changed ? "indexed" : "skipped"} ${f} (${x.chunks} chunks)`); } }); return out(r); }
      if (sub === "query") { const hits = await c.rag.retrieve(kb(rest[0] ?? die("kb")), rest[1] ?? die("query"), { k: flags.k ? Number(flags.k) : 5, mode: flags.mode as never }); return out(flags.json ? hits : hits.map((h, i) => `${i + 1}. [${h.score.toFixed(4)} v=${h.signals.vector?.toFixed(3) ?? "-"} k=${h.signals.keyword?.toFixed(2) ?? "-"}] ${h.chunk.text.slice(0, 200).replace(/\n/g, " ")}`).join("\n")); }
      if (sub === "eval") { const r = await c.rag.evaluateRetrieval(kb(rest[0] ?? die("kb")), readJson(rest[1] ?? die("cases file")) as never, { k: flags.k ? Number(flags.k) : 5, mode: flags.mode as never }); return out(flags.json ? r : `recall@${r.k}=${r.recallAtK.toFixed(3)} mrr=${r.mrr.toFixed(3)} hitRate=${r.hitRate.toFixed(3)}\n${table(r.perCase.map((p) => ({ query: p.query, hit: p.hit, rank: p.rank ?? "-" })))}`); }
      break;
    }
    case "gateway": {
      const c = ctx();
      if (sub === "models") return out({ providers: c.gateway.router.listProviders().map((p) => ({ provider: p.name, models: p.models() })), routes: c.gateway.router.getConfig().routes });
      if (sub === "routes" && rest[0] === "show") return out(c.gateway.router.getConfig());
      if (sub === "routes" && rest[0] === "set") { const cfg = RouterConfig.parse(readJson(rest[1] ?? die("file"))); c.store.ops.kvSet("gateway.routes", cfg); return out(`saved ${cfg.routes.length} routes (restart the server to apply)`); }
      if (sub === "requests") return out(flags.json ? c.store.gateway.list(c.project.id, Number(flags.limit ?? 50)) : table(c.store.gateway.list(c.project.id, Number(flags.limit ?? 50)).map((r) => ({ when: fmt.ago(r.createdAt), route: r.route, model: r.servedModel, provider: r.provider, status: r.status, cached: r.cached, latency: fmt.ms(r.latencyMs), cost: fmt.usd(r.costUsd) }))));
      if (sub === "key" && rest[0] === "create") { const { key, secret } = c.store.gateway.createKey(c.project.id, rest[1] ?? die("name")); return out(flags.json ? { ...key, secret } : `${secret}\n(store this now; it is not shown again)`); }
      if (sub === "budget" && rest[0] === "set") return out(c.store.gateway.setBudget({ projectId: c.project.id, scope: rest[1] ?? "project", limitUsd: Number(rest[2] ?? die("usd")), period: (rest[3] as never) ?? "monthly" }));
      if (sub === "budget" && rest[0] === "list") return out(c.store.gateway.listBudgets(c.project.id));
      break;
    }
    case "chat": {
      const c = ctx();
      const model = sub ?? die("model or route required, e.g. crucible chat free \"hello\"");
      const prompt = rest.join(" ") || die("prompt required");
      const messages = [...(flags.system ? [{ role: "system" as const, content: String(flags.system) }] : []), { role: "user" as const, content: prompt }];
      if (model === "free" && c.freeRouteAuto) await refreshFreeModels(c).catch(() => undefined);
      let usage: { inputTokens: number; outputTokens: number } | null = null;
      for await (const ev of c.gateway.stream({ messages, config: { model } }, { projectId: c.project.id })) {
        if (ev.type === "text_delta") process.stdout.write(ev.text);
        else if (ev.type === "end") usage = ev.usage;
        else if (ev.type === "error") {
          const allLimited = /all \d+ target\(s\) failed/.test(ev.error) && c.store.gateway.list(c.project.id, 50).filter((r) => r.route === model).slice(0, 3).every((r) => r.status === 429);
          die(allLimited ? `${ev.error}\nhint: the free tiers are rate limiting this machine. Set OPENROUTER_API_KEY (free at openrouter.ai) to add OpenRouter free models to the route, or retry later.` : ev.error);
        }
      }
      const served = c.store.gateway.list(c.project.id, 1)[0];
      process.stdout.write("\n");
      if (!flags.json) console.error(`\n[${served?.provider ?? "?"}/${served?.servedModel ?? model}${served?.fallbackDepth ? ` after ${served.fallbackDepth} fallback(s)` : ""} · ${usage?.inputTokens ?? 0} in / ${usage?.outputTokens ?? 0} out · ${fmt.ms(served?.latencyMs ?? 0)}]`);
      return;
    }
    case "cli": {
      if (sub === "status") {
        const st = await allCliStatus();
        if (flags.json) return out(st);
        console.log(table(st.map((s) => ({ cli: s.name, purpose: s.purpose, installed: s.installed ? "yes" : "no", version: s.version ?? "", "signed in": s.loggedIn === null ? "unknown" : s.loggedIn ? "yes" : "no", detail: s.detail }))));
        const todo = st.filter((s) => s.installed && s.loggedIn === false);
        if (todo.length) console.log(`\nSign in with:\n${todo.map((s) => `  crucible cli login ${s.name === "claude-code" ? "claude" : s.name}    (runs: ${s.loginCommand})`).join("\n")}`);
        console.log(`\nUse them by pinning (claude-code/sonnet, codex/default, opencode/<model>, cline/<provider>/<model>) or via the routes claude-subscription, codex-subscription and free.`);
        return;
      }
      if (sub === "login") {
        const which_ = (rest[0] ?? die("which CLI? claude | codex | opencode | cline")) as string;
        const name = (which_ === "claude" ? "claude-code" : which_) as CliName;
        if (!LOGIN[name]) die(`unknown CLI: ${which_}`);
        const bin = cliBinary(name);
        if (!which(bin)) die(`${bin} is not installed`);
        const args = [...LOGIN[name].args, ...(name === "codex" && flags.device ? ["--device-auth"] : [])];
        console.error(`running: ${bin} ${args.join(" ")}\n(credentials stay with ${bin}; Crucible never reads them)\n`);
        const code = await new Promise<number>((resolve) => spawn(bin, args, { stdio: "inherit" }).on("close", (c) => resolve(c ?? 1)));
        process.exit(code);
      }
      if (sub === "free") {
        const cat = await discoverFreeModels();
        const have = { opencode: !!which("opencode"), cline: !!which("cline"), openrouterKey: !!process.env.OPENROUTER_API_KEY };
        const route = buildFreeRoute(cat, have);
        if (flags.json) return out({ catalog: cat, route });
        console.log(`OpenCode Zen free models (no login needed${have.opencode ? "" : "; opencode not installed"}):\n${cat.opencodeZen.map((m) => `  opencode/${m}`).join("\n") || "  (none found)"}`);
        console.log(`\nOpenRouter free models (${have.openrouterKey ? "OPENROUTER_API_KEY set" : "need OPENROUTER_API_KEY, free to create"}): ${cat.openrouter.length}\n${cat.openrouter.slice(0, 8).map((m) => `  cline/openrouter/${m}`).join("\n")}${cat.openrouter.length > 8 ? "\n  ..." : ""}`);
        if (cat.errors.length) console.log(`\nerrors: ${cat.errors.join("; ")}`);
        console.log(`\nfree route (fallback order):\n${route ? route.targets.map((t, i) => `  ${i + 1}. ${t.provider}/${t.model}`).join("\n") : "  (no free targets available)"}`);
        return;
      }
      break;
    }
    case "ops": {
      const c = ctx();
      if (sub === "approvals") return out(flags.json ? c.store.ops.listApprovals(c.project.id, "pending") : table(c.store.ops.listApprovals(c.project.id, "pending").map((a) => ({ id: a.id, run: a.runId, title: a.title, details: a.details, requested: fmt.ago(a.requestedAt) }))));
      if (sub === "approve" || sub === "reject") { const a = c.store.ops.resolveApproval(rest[0] ?? die("approval id"), sub === "approve" ? "approved" : "rejected", "cli", flags.reason as string) ?? die("not found"); c.store.ops.audit({ projectId: c.project.id, actor: "cli", action: `approval.${a.status}`, targetType: "approval", targetId: a.id }); return out(a); }
      if (sub === "audit") return out(flags.json ? c.store.ops.auditLog(c.project.id) : table(c.store.ops.auditLog(c.project.id, 50).map((e) => ({ when: fmt.ago(e.ts), actor: e.actor, action: e.action, target: `${e.targetType}:${e.targetId}`, details: e.details }))));
      if (sub === "overview") return out({ traces: c.store.tracing.stats(c.project.id, 86400_000), gateway: c.store.gateway.stats(c.project.id, 86400_000), fleet: c.store.agents.fleet(c.project.id, 86400_000), pendingApprovals: c.store.ops.listApprovals(c.project.id, "pending").length, budgets: c.store.gateway.listBudgets(c.project.id) });
      break;
    }
  }
  console.log(HELP);
  process.exit(2);
}

main().catch((err) => die((err as Error).message));
// Keep these imports referenced for tree-shaking-free builds of optional helpers.
void Gateway; void MemoryCache; void Router; void AgentRuntime; void RagPipeline;
