import type { ChatRequest, Message } from "@crucible/core";
import { MockProvider } from "./mock.js";

const textOf = (m: Message | undefined): string => (!m ? "" : typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? p.text : p.type === "tool_result" ? p.content : "")).join(" "));

/**
 * A scripted offline model that behaves plausibly enough to demo every feature without API keys:
 * it uses tools when offered, answers trivia and arithmetic, and acts as a sane LLM judge.
 */
export function demoReply(req: ChatRequest): string | { text?: string; toolUse?: { name: string; input: unknown } } {
  const all = req.messages.map(textOf).join("\n");
  const last = req.messages[req.messages.length - 1];
  const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
  const user = textOf(lastUser);
  const tools = req.config.tools ?? [];
  const lastIsToolResult = !!last && typeof last.content !== "string" && last.content.some((p) => p.type === "tool_result");

  // LLM-as-judge: score by whether the expected text shows up in the response.
  if (all.includes("You are a strict evaluator")) {
    const expected = /EXPECTED[^\n]*:\n([\s\S]*?)\n\nRESPONSE:/.exec(all)?.[1]?.trim();
    const response = /RESPONSE:\n([\s\S]*)$/.exec(all)?.[1]?.trim() ?? "";
    const [lo, hi] = (/scale from (-?\d+(?:\.\d+)?) to (-?\d+(?:\.\d+)?)/.exec(all)?.slice(1, 3).map(Number) as [number, number] | undefined) ?? [0, 1];
    const good = expected ? response.toLowerCase().includes(expected.toLowerCase()) : response.length > 0 && response.length < 400;
    return JSON.stringify({ score: good ? hi : lo, reason: good ? "response matches the reference" : "response does not contain the expected answer" });
  }
  // Reranker prompt
  if (all.includes("Rate how relevant each passage")) {
    const n = (all.match(/^\[\d+\]/gm) ?? []).length;
    return JSON.stringify(Array.from({ length: n }, (_, i) => Math.max(0, 9 - i)));
  }
  // After a tool result, summarize it.
  if (lastIsToolResult) {
    const result = textOf(last);
    if (/rejected by a human/i.test(result)) return "The action was rejected by a reviewer, so I stopped.";
    if (/^deployed/i.test(result)) return `Done: ${result}.`;
    return `Based on what I found: ${result.replace(/^- \([\d.]+\) /gm, "").trim().slice(0, 400)}`;
  }
  // Pick a tool when one fits.
  const has = (n: string) => tools.some((t) => t.name === n);
  if (has("deploy") && /deploy/i.test(user)) {
    const service = /deploy\s+(?:the\s+)?([\w-]+)/i.exec(user)?.[1] ?? "api";
    const environment = /prod/i.test(user) ? "production" : "staging";
    return { toolUse: { name: "deploy", input: { service, environment } } };
  }
  const arith = /(-?\d+(?:\.\d+)?(?:\s*[-+*/%]\s*-?\d+(?:\.\d+)?)+)/.exec(user)?.[1];
  if (has("calculate") && arith) return { toolUse: { name: "calculate", input: { expression: arith.trim() } } };
  if (has("search_knowledge")) return { toolUse: { name: "search_knowledge", input: { query: user.slice(0, 120) } } };
  if (tools.length && req.config.toolChoice === "required") return { toolUse: { name: tools[0]!.name, input: {} } };
  // Plain answers.
  if (arith) { try { return String(Function(`"use strict"; return (${arith})`)()); } catch { /* ignore */ } }
  const trivia: Array<[RegExp, string]> = [[/capital of france/i, "Paris"], [/capital of (peru)/i, "Lima"], [/capital of (japan)/i, "Tokyo"], [/capital of (germany)/i, "Berlin"], [/capital of (italy)/i, "Rome"], [/capital of (spain)/i, "Madrid"], [/largest planet/i, "Jupiter"], [/who wrote hamlet/i, "William Shakespeare"]];
  for (const [re, a] of trivia) if (re.test(user)) return a;
  if (/model gateway/i.test(user)) return "A model gateway is a single endpoint that routes requests to many LLM providers while adding caching, fallbacks, budgets and tracing. It lets you swap models without changing application code.";
  return `(demo model) You said: ${user.slice(0, 200)}`;
}

export function demoProvider(): MockProvider {
  return new MockProvider({ name: "mock", reply: demoReply, models: ["mock-smart", "mock-fast"] });
}
