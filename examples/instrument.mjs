// Run with the server up:  node examples/instrument.mjs
// Shows the SDK: traces + spans, versioned prompt fetch, and calling models through the gateway.
import { Crucible } from "@crucible/sdk";

const crucible = new Crucible({ baseUrl: process.env.CRUCIBLE_URL ?? "http://localhost:4800", project: "default" });

// Make sure a prompt exists (normally you'd do this once in the UI or with `crucible prompt push`).
await fetch(`${crucible.project && "http://localhost:4800"}/api/projects/default/prompts`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "summarize", template: [{ role: "system", content: "Summarize in one sentence." }, { role: "user", content: "{{text}}" }], config: { model: "fast" }, labels: ["production"] }),
}).catch(() => undefined);

const summary = await crucible.traced("summarize-request", async (trace) => {
  const { version, messages } = await crucible.prompt("summarize@production", { text: "Crucible is an open-core AI engineering platform with evals, tracing, agent replay, a model gateway, RAG and ops in one tool." });
  trace.trace.metadata.promptVersion = version.version;
  return crucible.withSpan(trace, "llm", "llm", async (span) => {
    const res = await crucible.chat({ messages, config: version.config });
    span.setUsage(res.usage, res.model).setAttributes({ provider: res.provider, cached: res.cached });
    return typeof res.message.content === "string" ? res.message.content : JSON.stringify(res.message.content);
  }, messages);
}, { tags: ["example"], userId: "demo-user" });

console.log("summary:", summary);
await crucible.shutdown(); // flushes the trace
console.log("trace exported; open http://localhost:4800/#/traces");
