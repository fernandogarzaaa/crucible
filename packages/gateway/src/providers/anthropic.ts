import type { ChatRequest, ChatResponse, ContentPart, Message, Usage } from "@crucible/core";
import { ProviderError, isRetryableStatus, type Provider, type StreamEvent } from "../types.js";
import { parseSse } from "./sse.js";

export interface AnthropicOptions {
  apiKey?: string;
  baseUrl?: string;
  version?: string;
  fetch?: typeof fetch;
  models?: string[];
}

const DEFAULT_MODELS = ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-sonnet-4-5", "claude-haiku-4-5"];

type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

function toAnthropic(req: ChatRequest): Record<string, unknown> {
  const system: string[] = [];
  const messages: Array<{ role: "user" | "assistant"; content: AnthropicBlock[] | string }> = [];
  for (const m of req.messages) {
    if (m.role === "system") {
      system.push(typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? p.text : "")).join("\n"));
      continue;
    }
    const role = m.role === "assistant" ? "assistant" : "user";
    const blocks: AnthropicBlock[] =
      typeof m.content === "string"
        ? [{ type: "text", text: m.content }]
        : m.content.map((p): AnthropicBlock => {
            switch (p.type) {
              case "text": return { type: "text", text: p.text };
              case "image": return { type: "image", source: { type: "base64", media_type: p.mediaType, data: p.data } };
              case "tool_use": return { type: "tool_use", id: p.id, name: p.name, input: p.input };
              case "tool_result": return { type: "tool_result", tool_use_id: p.toolUseId, content: p.content, is_error: p.isError };
            }
          });
    // Anthropic requires alternating roles; merge consecutive same-role messages.
    const last = messages[messages.length - 1];
    if (last && last.role === role && Array.isArray(last.content)) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  }
  const c = req.config;
  const body: Record<string, unknown> = {
    model: c.model, messages, max_tokens: c.maxTokens ?? 4096, stream: req.stream ?? false,
  };
  if (system.length) body.system = system.join("\n\n");
  if (c.temperature !== undefined) body.temperature = c.temperature;
  if (c.topP !== undefined) body.top_p = c.topP;
  if (c.stopSequences?.length) body.stop_sequences = c.stopSequences;
  if (c.tools?.length) {
    body.tools = c.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
    if (c.toolChoice === "required") body.tool_choice = { type: "any" };
    else if (c.toolChoice === "none") body.tool_choice = { type: "none" };
    else if (typeof c.toolChoice === "object") body.tool_choice = { type: "tool", name: c.toolChoice.name };
  }
  return body;
}

function fromStop(s: string | null | undefined): ChatResponse["stopReason"] {
  switch (s) {
    case "end_turn": return "end_turn";
    case "max_tokens": return "max_tokens";
    case "tool_use": return "tool_use";
    case "stop_sequence": return "stop_sequence";
    default: return "end_turn";
  }
}

function usageFrom(u: Record<string, number> | undefined): Usage {
  return {
    inputTokens: u?.input_tokens ?? 0, outputTokens: u?.output_tokens ?? 0,
    cacheReadTokens: u?.cache_read_input_tokens, cacheWriteTokens: u?.cache_creation_input_tokens,
  };
}

export class AnthropicProvider implements Provider {
  readonly name = "anthropic";
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly version: string;
  private readonly f: typeof fetch;
  private readonly modelList: string[];

  constructor(opts: AnthropicOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "";
    this.baseUrl = (opts.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/$/, "");
    this.version = opts.version ?? "2023-06-01";
    this.f = opts.fetch ?? fetch;
    this.modelList = opts.models ?? DEFAULT_MODELS;
  }
  models() { return this.modelList; }
  supports(model: string) { return model.startsWith("claude"); }

  private async post(body: unknown, signal?: AbortSignal): Promise<Response> {
    if (!this.apiKey) throw new ProviderError("ANTHROPIC_API_KEY is not set", this.name, 401, false);
    const res = await this.f(`${this.baseUrl}/v1/messages`, {
      method: "POST", signal,
      headers: { "content-type": "application/json", "x-api-key": this.apiKey, "anthropic-version": this.version },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ProviderError(`anthropic ${res.status}: ${text.slice(0, 500)}`, this.name, res.status, isRetryableStatus(res.status));
    }
    return res;
  }

  async chat(req: ChatRequest, signal?: AbortSignal) {
    const res = await this.post({ ...toAnthropic(req), stream: false }, signal);
    const data = (await res.json()) as { id: string; model: string; content: AnthropicBlock[]; stop_reason: string; usage: Record<string, number> };
    const parts: ContentPart[] = data.content.map((b) => {
      if (b.type === "text") return { type: "text", text: b.text };
      if (b.type === "tool_use") return { type: "tool_use", id: b.id, name: b.name, input: b.input };
      return { type: "text", text: "" };
    });
    const message: Message = { role: "assistant", content: parts };
    return { id: data.id, model: data.model, provider: this.name, message, stopReason: fromStop(data.stop_reason), usage: usageFrom(data.usage) };
  }

  async *stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const res = await this.post({ ...toAnthropic(req), stream: true }, signal);
    const parts: ContentPart[] = [];
    const toolJson = new Map<number, string>();
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let stop: ChatResponse["stopReason"] = "end_turn";
    for await (const ev of parseSse(res)) {
      const d = ev.data as Record<string, any>;
      switch (ev.event) {
        case "message_start":
          usage = usageFrom(d.message?.usage);
          yield { type: "start", id: d.message?.id ?? "", model: d.message?.model ?? req.config.model };
          break;
        case "content_block_start": {
          const cb = d.content_block;
          if (cb.type === "text") parts[d.index] = { type: "text", text: "" };
          else if (cb.type === "tool_use") { parts[d.index] = { type: "tool_use", id: cb.id, name: cb.name, input: {} }; toolJson.set(d.index, ""); yield { type: "tool_use_start", id: cb.id, name: cb.name }; }
          break;
        }
        case "content_block_delta": {
          const p = parts[d.index];
          if (d.delta.type === "text_delta" && p?.type === "text") { p.text += d.delta.text; yield { type: "text_delta", text: d.delta.text }; }
          else if (d.delta.type === "input_json_delta" && p?.type === "tool_use") { toolJson.set(d.index, (toolJson.get(d.index) ?? "") + d.delta.partial_json); yield { type: "tool_use_delta", id: p.id, inputJsonDelta: d.delta.partial_json }; }
          break;
        }
        case "content_block_stop": {
          const p = parts[d.index];
          if (p?.type === "tool_use") { try { p.input = JSON.parse(toolJson.get(d.index) || "{}"); } catch { p.input = {}; } yield { type: "tool_use_end", id: p.id }; }
          break;
        }
        case "message_delta":
          if (d.usage) { usage = { ...usage, outputTokens: d.usage.output_tokens ?? usage.outputTokens }; yield { type: "usage", usage: { outputTokens: usage.outputTokens } }; }
          if (d.delta?.stop_reason) stop = fromStop(d.delta.stop_reason);
          break;
        case "error":
          yield { type: "error", error: JSON.stringify(d.error ?? d) };
          break;
      }
    }
    yield { type: "end", stopReason: stop, message: { role: "assistant", content: parts.filter(Boolean) }, usage };
  }
}
