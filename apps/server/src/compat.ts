import type { ChatRequest, ChatResponse, ContentPart, Message } from "@crucible/core";
import type { StreamEvent } from "@crucible/gateway";

// ---------------- OpenAI Chat Completions compatibility ----------------

export function fromOpenAIRequest(body: any): ChatRequest {
  const messages: Message[] = [];
  for (const m of body.messages ?? []) {
    if (m.role === "tool") { messages.push({ role: "user", content: [{ type: "tool_result", toolUseId: m.tool_call_id, content: typeof m.content === "string" ? m.content : JSON.stringify(m.content) }] }); continue; }
    const parts: ContentPart[] = [];
    if (typeof m.content === "string") parts.push({ type: "text", text: m.content });
    else for (const p of m.content ?? []) {
      if (p.type === "text") parts.push({ type: "text", text: p.text });
      else if (p.type === "image_url") { const mm = /^data:([^;]+);base64,(.*)$/.exec(p.image_url?.url ?? ""); if (mm) parts.push({ type: "image", mediaType: mm[1]!, data: mm[2]! }); }
    }
    for (const tc of m.tool_calls ?? []) { let input: unknown = {}; try { input = JSON.parse(tc.function?.arguments || "{}"); } catch { /* ignore */ } parts.push({ type: "tool_use", id: tc.id, name: tc.function?.name, input }); }
    messages.push({ role: m.role, content: parts.length === 1 && parts[0]!.type === "text" ? parts[0]!.text : parts });
  }
  const tools = body.tools?.map((t: any) => ({ name: t.function?.name, description: t.function?.description, inputSchema: t.function?.parameters ?? { type: "object" } }));
  const tc = body.tool_choice;
  return {
    messages, stream: !!body.stream, metadata: body.metadata,
    config: {
      model: body.model, temperature: body.temperature, maxTokens: body.max_completion_tokens ?? body.max_tokens, topP: body.top_p,
      stopSequences: typeof body.stop === "string" ? [body.stop] : body.stop, tools,
      toolChoice: tc === "required" ? "required" : tc === "none" ? "none" : tc?.function?.name ? { name: tc.function.name } : undefined,
      responseFormat: body.response_format?.type === "json_object" || body.response_format?.type === "json_schema" ? "json" : undefined,
    },
  };
}

export function toOpenAIResponse(res: ChatResponse) {
  const parts = typeof res.message.content === "string" ? [{ type: "text", text: res.message.content } as ContentPart] : res.message.content;
  const text = parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("") || null;
  const tool_calls = parts.filter((p) => p.type === "tool_use").map((p: any) => ({ id: p.id, type: "function", function: { name: p.name, arguments: JSON.stringify(p.input ?? {}) } }));
  return {
    id: res.id || `chatcmpl_${Date.now()}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: res.model,
    choices: [{ index: 0, message: { role: "assistant", content: text, ...(tool_calls.length ? { tool_calls } : {}) }, finish_reason: res.stopReason === "tool_use" ? "tool_calls" : res.stopReason === "max_tokens" ? "length" : "stop" }],
    usage: { prompt_tokens: res.usage.inputTokens, completion_tokens: res.usage.outputTokens, total_tokens: res.usage.inputTokens + res.usage.outputTokens },
    crucible: { provider: res.provider, cached: res.cached, cost_usd: res.costUsd, latency_ms: res.latencyMs },
  };
}

export function* toOpenAIChunks(ev: StreamEvent, id: string, model: string): Generator<string> {
  const base = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model };
  const frame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
  switch (ev.type) {
    case "start": yield frame({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }); break;
    case "text_delta": yield frame({ ...base, choices: [{ index: 0, delta: { content: ev.text }, finish_reason: null }] }); break;
    case "tool_use_start": yield frame({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: ev.id, type: "function", function: { name: ev.name, arguments: "" } }] }, finish_reason: null }] }); break;
    case "tool_use_delta": yield frame({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ev.inputJsonDelta } }] }, finish_reason: null }] }); break;
    case "end": yield frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: ev.stopReason === "tool_use" ? "tool_calls" : ev.stopReason === "max_tokens" ? "length" : "stop" }], usage: { prompt_tokens: ev.usage.inputTokens, completion_tokens: ev.usage.outputTokens, total_tokens: ev.usage.inputTokens + ev.usage.outputTokens } }); yield "data: [DONE]\n\n"; break;
    case "error": yield frame({ error: { message: ev.error, type: "upstream_error" } }); yield "data: [DONE]\n\n"; break;
    default: break;
  }
}

// ---------------- Anthropic Messages compatibility ----------------

export function fromAnthropicRequest(body: any): ChatRequest {
  const messages: Message[] = [];
  if (body.system) messages.push({ role: "system", content: typeof body.system === "string" ? body.system : body.system.map((b: any) => b.text ?? "").join("\n") });
  for (const m of body.messages ?? []) {
    if (typeof m.content === "string") { messages.push({ role: m.role, content: m.content }); continue; }
    const parts: ContentPart[] = m.content.map((b: any): ContentPart => {
      switch (b.type) {
        case "text": return { type: "text", text: b.text };
        case "image": return { type: "image", mediaType: b.source?.media_type ?? "image/png", data: b.source?.data ?? "" };
        case "tool_use": return { type: "tool_use", id: b.id, name: b.name, input: b.input };
        case "tool_result": return { type: "tool_result", toolUseId: b.tool_use_id, content: typeof b.content === "string" ? b.content : JSON.stringify(b.content), isError: b.is_error };
        default: return { type: "text", text: "" };
      }
    });
    messages.push({ role: m.role, content: parts });
  }
  const tc = body.tool_choice;
  return {
    messages, stream: !!body.stream, metadata: body.metadata,
    config: {
      model: body.model, maxTokens: body.max_tokens, temperature: body.temperature, topP: body.top_p, stopSequences: body.stop_sequences,
      tools: body.tools?.map((t: any) => ({ name: t.name, description: t.description, inputSchema: t.input_schema ?? { type: "object" } })),
      toolChoice: tc?.type === "any" ? "required" : tc?.type === "none" ? "none" : tc?.type === "tool" ? { name: tc.name } : undefined,
    },
  };
}

export function toAnthropicResponse(res: ChatResponse) {
  const parts = typeof res.message.content === "string" ? [{ type: "text", text: res.message.content } as ContentPart] : res.message.content;
  return {
    id: res.id || `msg_${Date.now()}`, type: "message", role: "assistant", model: res.model,
    content: parts.map((p: any) => (p.type === "tool_use" ? { type: "tool_use", id: p.id, name: p.name, input: p.input } : { type: "text", text: p.text ?? "" })),
    stop_reason: res.stopReason, stop_sequence: null,
    usage: { input_tokens: res.usage.inputTokens, output_tokens: res.usage.outputTokens, cache_read_input_tokens: res.usage.cacheReadTokens ?? 0, cache_creation_input_tokens: res.usage.cacheWriteTokens ?? 0 },
  };
}

export function* toAnthropicEvents(ev: StreamEvent, id: string, model: string, state: { index: number; textOpen: boolean }): Generator<string> {
  const frame = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`;
  switch (ev.type) {
    case "start": yield frame("message_start", { message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } }); break;
    case "text_delta":
      if (!state.textOpen) { yield frame("content_block_start", { index: state.index, content_block: { type: "text", text: "" } }); state.textOpen = true; }
      yield frame("content_block_delta", { index: state.index, delta: { type: "text_delta", text: ev.text } }); break;
    case "tool_use_start":
      if (state.textOpen) { yield frame("content_block_stop", { index: state.index }); state.textOpen = false; state.index++; }
      yield frame("content_block_start", { index: state.index, content_block: { type: "tool_use", id: ev.id, name: ev.name, input: {} } }); break;
    case "tool_use_delta": yield frame("content_block_delta", { index: state.index, delta: { type: "input_json_delta", partial_json: ev.inputJsonDelta } }); break;
    case "tool_use_end": yield frame("content_block_stop", { index: state.index }); state.index++; break;
    case "end":
      if (state.textOpen) { yield frame("content_block_stop", { index: state.index }); state.textOpen = false; }
      yield frame("message_delta", { delta: { stop_reason: ev.stopReason, stop_sequence: null }, usage: { output_tokens: ev.usage.outputTokens, input_tokens: ev.usage.inputTokens } });
      yield frame("message_stop", {}); break;
    case "error": yield frame("error", { error: { type: "api_error", message: ev.error } }); break;
    default: break;
  }
}

// ---------------- OpenAI Responses API compatibility (used by Codex and newer OpenAI SDKs) ----------------

type RespItem = Record<string, any>;

const respText = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((c: any) => (typeof c === "string" ? c : c?.text ?? "")).join("") : "";

export function fromResponsesRequest(body: any): ChatRequest {
  const messages: Message[] = [];
  if (body.instructions) messages.push({ role: "system", content: String(body.instructions) });
  const items: RespItem[] = typeof body.input === "string" ? [{ type: "message", role: "user", content: body.input }] : Array.isArray(body.input) ? body.input : [];
  for (const it of items) {
    const type = it.type ?? "message";
    if (type === "message") {
      const role = it.role === "developer" || it.role === "system" ? "system" : it.role === "assistant" ? "assistant" : "user";
      const parts: ContentPart[] = [];
      if (typeof it.content === "string") parts.push({ type: "text", text: it.content });
      else for (const c of it.content ?? []) {
        if (c.type === "input_text" || c.type === "output_text" || c.type === "text") parts.push({ type: "text", text: c.text ?? "" });
        else if (c.type === "input_image" && typeof c.image_url === "string") { const mm = /^data:([^;]+);base64,(.*)$/.exec(c.image_url); if (mm) parts.push({ type: "image", mediaType: mm[1]!, data: mm[2]! }); }
      }
      if (role === "system") messages.push({ role: "system", content: parts.map((p) => (p.type === "text" ? p.text : "")).join("\n") });
      else messages.push({ role, content: parts.length === 1 && parts[0]!.type === "text" ? parts[0]!.text : parts });
    } else if (type === "function_call") {
      let input: unknown = {};
      try { input = JSON.parse(it.arguments || "{}"); } catch { input = { _raw: it.arguments }; }
      const part: ContentPart = { type: "tool_use", id: it.call_id ?? it.id, name: it.name, input };
      const last = messages[messages.length - 1];
      if (last?.role === "assistant" && Array.isArray(last.content)) last.content.push(part); else messages.push({ role: "assistant", content: [part] });
    } else if (type === "function_call_output") {
      const part: ContentPart = { type: "tool_result", toolUseId: it.call_id, content: typeof it.output === "string" ? it.output : respText(it.output) || JSON.stringify(it.output) };
      const last = messages[messages.length - 1];
      if (last?.role === "user" && Array.isArray(last.content) && last.content.every((p) => p.type === "tool_result")) last.content.push(part); else messages.push({ role: "user", content: [part] });
    }
    // reasoning and other item types carry no content the gateway needs to replay
  }
  const tools = (body.tools ?? []).filter((t: any) => t.type === "function" && t.name).map((t: any) => ({ name: t.name, description: t.description, inputSchema: t.parameters ?? { type: "object" } }));
  const tc = body.tool_choice;
  return {
    messages, stream: !!body.stream, metadata: body.metadata,
    config: {
      model: body.model, maxTokens: body.max_output_tokens, temperature: body.temperature, topP: body.top_p,
      tools: tools.length ? tools : undefined,
      toolChoice: tc === "required" ? "required" : tc === "none" ? "none" : tc?.name ? { name: tc.name } : undefined,
      responseFormat: body.text?.format?.type === "json_object" || body.text?.format?.type === "json_schema" ? "json" : undefined,
    },
  };
}

const respUsage = (u: { inputTokens: number; outputTokens: number; cacheReadTokens?: number }) => ({
  input_tokens: u.inputTokens, input_tokens_details: { cached_tokens: u.cacheReadTokens ?? 0 },
  output_tokens: u.outputTokens, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: u.inputTokens + u.outputTokens,
});

function respOutput(message: Message, idBase: string): RespItem[] {
  const parts = typeof message.content === "string" ? [{ type: "text", text: message.content } as ContentPart] : message.content;
  const out: RespItem[] = [];
  const text = parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("");
  if (text) out.push({ type: "message", id: `msg_${idBase}`, status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] });
  parts.forEach((p, i) => { if (p.type === "tool_use") out.push({ type: "function_call", id: `fc_${idBase}_${i}`, call_id: p.id, name: p.name, arguments: JSON.stringify(p.input ?? {}), status: "completed" }); });
  return out;
}

export function toResponsesResponse(res: ChatResponse, req: ChatRequest) {
  const id = `resp_${Date.now().toString(36)}`;
  return {
    id, object: "response", created_at: Math.floor(Date.now() / 1000), status: res.stopReason === "max_tokens" ? "incomplete" : "completed",
    incomplete_details: res.stopReason === "max_tokens" ? { reason: "max_output_tokens" } : null,
    model: res.model, output: respOutput(res.message, id), usage: respUsage(res.usage),
    instructions: null, tools: req.config.tools?.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.inputSchema })) ?? [],
    parallel_tool_calls: true, error: null,
    crucible: { provider: res.provider, cached: res.cached, cost_usd: res.costUsd, latency_ms: res.latencyMs },
  };
}

/** Stateful translator from gateway stream events to Responses API SSE frames. */
export function responsesStreamer(model: string) {
  const id = `resp_${Date.now().toString(36)}`;
  let seq = 0;
  const frame = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`;
  const base = { id, object: "response", created_at: Math.floor(Date.now() / 1000), model, output: [] as RespItem[], error: null };
  let outputIndex = -1;
  let text: { item: RespItem; index: number; buf: string } | null = null;
  const calls = new Map<string, { item: RespItem; index: number; args: string }>();
  const closeText = (): string[] => {
    if (!text) return [];
    const t = text; text = null;
    t.item.content = [{ type: "output_text", text: t.buf, annotations: [] }];
    t.item.status = "completed";
    base.output.push(t.item);
    return [
      frame("response.output_text.done", { item_id: t.item.id, output_index: t.index, content_index: 0, text: t.buf }),
      frame("response.content_part.done", { item_id: t.item.id, output_index: t.index, content_index: 0, part: { type: "output_text", text: t.buf, annotations: [] } }),
      frame("response.output_item.done", { output_index: t.index, item: t.item }),
    ];
  };
  return {
    *on(ev: StreamEvent): Generator<string> {
      switch (ev.type) {
        case "start":
          yield frame("response.created", { response: { ...base, status: "in_progress" } });
          yield frame("response.in_progress", { response: { ...base, status: "in_progress" } });
          break;
        case "text_delta":
          if (!text) {
            outputIndex++;
            text = { item: { type: "message", id: `msg_${id}_${outputIndex}`, status: "in_progress", role: "assistant", content: [] }, index: outputIndex, buf: "" };
            yield frame("response.output_item.added", { output_index: outputIndex, item: { ...text.item } });
            yield frame("response.content_part.added", { item_id: text.item.id, output_index: outputIndex, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
          }
          text.buf += ev.text;
          yield frame("response.output_text.delta", { item_id: text.item.id, output_index: text.index, content_index: 0, delta: ev.text });
          break;
        case "tool_use_start": {
          yield* closeText();
          outputIndex++;
          const item = { type: "function_call", id: `fc_${id}_${outputIndex}`, call_id: ev.id, name: ev.name, arguments: "", status: "in_progress" };
          calls.set(ev.id, { item, index: outputIndex, args: "" });
          yield frame("response.output_item.added", { output_index: outputIndex, item: { ...item } });
          break;
        }
        case "tool_use_delta": {
          const c = calls.get(ev.id);
          if (!c) break;
          c.args += ev.inputJsonDelta;
          yield frame("response.function_call_arguments.delta", { item_id: c.item.id, output_index: c.index, delta: ev.inputJsonDelta });
          break;
        }
        case "tool_use_end": {
          const c = calls.get(ev.id);
          if (!c) break;
          c.item.arguments = c.args; c.item.status = "completed";
          base.output.push(c.item);
          yield frame("response.function_call_arguments.done", { item_id: c.item.id, output_index: c.index, arguments: c.args });
          yield frame("response.output_item.done", { output_index: c.index, item: c.item });
          break;
        }
        case "end":
          yield* closeText();
          yield frame("response.completed", { response: { ...base, status: ev.stopReason === "max_tokens" ? "incomplete" : "completed", usage: respUsage(ev.usage) } });
          break;
        case "error":
          yield* closeText();
          yield frame("response.failed", { response: { ...base, status: "failed", error: { code: "upstream_error", message: ev.error } } });
          break;
        default:
          break;
      }
    },
  };
}
