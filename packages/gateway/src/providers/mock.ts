import type { ChatRequest, Message, Usage } from "@crucible/core";
import { ProviderError, type Provider, type StreamEvent } from "../types.js";

export interface MockOptions {
  name?: string;
  /** Return a canned reply. Default echoes the last user message. */
  reply?: (req: ChatRequest) => string | { text?: string; toolUse?: { name: string; input: unknown } };
  /** Fail the first N calls with a retryable error (to exercise fallbacks). */
  failFirst?: number;
  latencyMs?: number;
  models?: string[];
}

/** Deterministic in-process provider for tests, demos and offline development. */
export class MockProvider implements Provider {
  readonly name: string;
  calls = 0;
  private readonly opts: MockOptions;
  constructor(opts: MockOptions = {}) {
    this.opts = opts;
    this.name = opts.name ?? "mock";
  }
  models() { return this.opts.models ?? ["mock-fast", "mock-smart"]; }
  supports(model: string) { return model.startsWith("mock"); }

  private respond(req: ChatRequest): { message: Message; usage: Usage; stopReason: "end_turn" | "tool_use" } {
    this.calls++;
    if (this.opts.failFirst && this.calls <= this.opts.failFirst) throw new ProviderError("mock failure", this.name, 503, true);
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    const lastText = lastUser ? (typeof lastUser.content === "string" ? lastUser.content : lastUser.content.map((p) => (p.type === "text" ? p.text : "")).join("")) : "";
    const r = this.opts.reply ? this.opts.reply(req) : `echo: ${lastText}`;
    const spec = typeof r === "string" ? { text: r } : r;
    const inTok = Math.ceil(JSON.stringify(req.messages).length / 4);
    if (spec.toolUse) {
      return {
        message: { role: "assistant", content: [{ type: "tool_use", id: `toolu_${this.calls}`, name: spec.toolUse.name, input: spec.toolUse.input }] },
        usage: { inputTokens: inTok, outputTokens: 20 }, stopReason: "tool_use",
      };
    }
    const text = spec.text ?? "";
    return { message: { role: "assistant", content: text }, usage: { inputTokens: inTok, outputTokens: Math.ceil(text.length / 4) }, stopReason: "end_turn" };
  }

  async chat(req: ChatRequest) {
    if (this.opts.latencyMs) await new Promise((r) => setTimeout(r, this.opts.latencyMs));
    const { message, usage, stopReason } = this.respond(req);
    return { id: `mock_${Date.now()}`, model: req.config.model, provider: this.name, message, stopReason, usage };
  }

  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    const { message, usage, stopReason } = this.respond(req);
    yield { type: "start", id: `mock_${Date.now()}`, model: req.config.model };
    if (typeof message.content === "string") {
      for (const word of message.content.split(/(?<=\s)/)) {
        if (this.opts.latencyMs) await new Promise((r) => setTimeout(r, Math.min(20, this.opts.latencyMs!)));
        yield { type: "text_delta", text: word };
      }
    } else {
      for (const p of message.content) if (p.type === "tool_use") { yield { type: "tool_use_start", id: p.id, name: p.name }; yield { type: "tool_use_delta", id: p.id, inputJsonDelta: JSON.stringify(p.input) }; yield { type: "tool_use_end", id: p.id }; }
    }
    yield { type: "end", stopReason, message, usage };
  }

  async embed(_model: string, inputs: string[]) {
    return { embeddings: inputs.map((t) => hashEmbed(t, 64)), usage: { inputTokens: inputs.join(" ").length / 4, outputTokens: 0 } };
  }
}

/** Cheap deterministic bag-of-words embedding. Good enough for tests and offline demos. */
export function hashEmbed(text: string, dims = 256): number[] {
  const v = new Array<number>(dims).fill(0);
  for (const tok of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    let h = 2166136261;
    for (let i = 0; i < tok.length; i++) { h ^= tok.charCodeAt(i); h = Math.imul(h, 16777619); }
    v[Math.abs(h) % dims]! += 1;
  }
  const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return v.map((x) => x / n);
}
