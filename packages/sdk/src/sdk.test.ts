import { describe, expect, it } from "vitest";
import { Crucible, type Transport } from "./index.js";

describe("sdk", () => {
  it("batches traces and spans and flushes them", async () => {
    const received: Array<{ traces: unknown[]; spans: unknown[] }> = [];
    const transport: Transport = { ingest: async (b) => { received.push(b); }, getPrompt: async () => undefined, chat: async () => { throw new Error("n/a"); } };
    const c = new Crucible({ transport, flushIntervalMs: 0 });
    const out = await c.traced("chat", async (t) => {
      await c.withSpan(t, "llm", "llm", async (s) => { s.setUsage({ inputTokens: 10, outputTokens: 5 }, "mock-fast"); return "hi"; });
      return { answer: "hi" };
    });
    expect(out.answer).toBe("hi");
    await c.flush();
    expect(received).toHaveLength(1);
    expect(received[0]!.spans).toHaveLength(1);
    expect(received[0]!.traces).toHaveLength(1);
    expect((received[0]!.traces[0] as { status: string }).status).toBe("ok");
  });
});
