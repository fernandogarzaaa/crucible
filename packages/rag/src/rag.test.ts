import { describe, expect, it } from "vitest";
import { Store } from "@crucible/core";
import { chunkText } from "./chunk.js";
import { RagPipeline } from "./pipeline.js";

describe("rag", () => {
  it("chunks on natural boundaries with overlap", () => {
    const text = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} talks about topic ${i % 3}. It has two sentences.`).join("\n\n");
    const chunks = chunkText(text, { chunkSize: 200, chunkOverlap: 40 });
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(200 + 40);
    expect(chunks[0]!.text.startsWith("Paragraph 0")).toBe(true);
  });

  it("ingests, retrieves hybrid results and evaluates retrieval", async () => {
    const store = Store.memory();
    const p = store.workbench.ensureDefaultProject();
    const kb = store.rag.createKb({ projectId: p.id, name: "docs", chunkSize: 300, chunkOverlap: 30 });
    const rag = new RagPipeline(store);
    await rag.ingestText(kb, { source: "budgets.md", content: "Budgets let you cap spend per project, API key, agent or model. When a hard-stop budget is exceeded the gateway returns HTTP 402." });
    await rag.ingestText(kb, { source: "replay.md", content: "Agent runs are recorded as an event log. You can replay a run deterministically or fork it from any step with a patched tool result." });
    await rag.ingestText(kb, { source: "tracing.md", content: "Traces contain spans of kind llm, tool, retriever and more, aligned with the OpenTelemetry GenAI semantic conventions." });
    const again = await rag.ingestText(kb, { source: "tracing.md", content: "Traces contain spans of kind llm, tool, retriever and more, aligned with the OpenTelemetry GenAI semantic conventions." });
    expect(again.changed).toBe(false);
    const hits = await rag.retrieve(kb, "how do I fork an agent run?", { k: 2 });
    expect(hits[0]!.chunk.text).toContain("fork");
    const report = await rag.evaluateRetrieval(kb, [
      { query: "exceeded budget http status", expectedSources: ["budgets.md"] },
      { query: "OpenTelemetry spans", expectedText: ["semantic conventions"] },
      { query: "replay deterministic", expectedSources: ["replay.md"] },
    ], { k: 1 });
    expect(report.hitRate).toBe(1);
    expect(report.mrr).toBe(1);
    store.close();
  });
});
