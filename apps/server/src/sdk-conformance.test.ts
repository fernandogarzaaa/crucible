import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve, type ServerType } from "@hono/node-server";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { Store } from "@crucible/core";
import { MockProvider } from "@crucible/gateway";
import { createApp, createContext } from "./app.js";

/**
 * Conformance: the official Anthropic and OpenAI SDKs, unmodified, pointed at Crucible's
 * compatibility endpoints. If these pass, existing apps can switch base URL and keep working.
 */
let server: ServerType;
let base = "";
const provider = new MockProvider({ reply: (req) => {
  const last = req.messages[req.messages.length - 1]!;
  if (Array.isArray(last.content) && last.content.some((p) => p.type === "tool_result")) return "It is sunny in Paris.";
  if (req.config.tools?.length) return { toolUse: { name: "get_weather", input: { city: "Paris" } } };
  return "pong from crucible";
} });

beforeAll(async () => {
  const ctx = createContext({ store: Store.memory(), providers: [provider], registerDemoAgents: false, loadUserAgents: false });
  const app = createApp(ctx, { quiet: true });
  await new Promise<void>((resolve) => { server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => { base = `http://127.0.0.1:${info.port}`; resolve(); }); });
});
afterAll(() => { server?.close(); });

const weatherTool = { name: "get_weather", description: "Weather for a city", input_schema: { type: "object" as const, properties: { city: { type: "string" } }, required: ["city"] } };

describe("official Anthropic SDK against /v1/messages", () => {
  const client = () => new Anthropic({ apiKey: "unused-local", baseURL: base });

  it("creates a message", async () => {
    const msg = await client().messages.create({ model: "mock-fast", max_tokens: 50, messages: [{ role: "user", content: "ping" }] });
    expect(msg.type).toBe("message");
    expect(msg.role).toBe("assistant");
    expect(msg.content[0]).toMatchObject({ type: "text", text: "pong from crucible" });
    expect(msg.stop_reason).toBe("end_turn");
    expect(msg.usage.input_tokens).toBeGreaterThan(0);
  });

  it("streams a message with the SDK's stream helper", async () => {
    const stream = client().messages.stream({ model: "mock-fast", max_tokens: 50, messages: [{ role: "user", content: "ping" }] });
    let text = "";
    stream.on("text", (t) => { text += t; });
    const final = await stream.finalMessage();
    expect(text).toBe("pong from crucible");
    expect(final.content[0]).toMatchObject({ type: "text", text: "pong from crucible" });
    expect(final.stop_reason).toBe("end_turn");
  });

  it("round-trips a tool call", async () => {
    const first = await client().messages.create({ model: "mock-fast", max_tokens: 100, tools: [weatherTool], messages: [{ role: "user", content: "weather in Paris?" }] });
    expect(first.stop_reason).toBe("tool_use");
    const tu = first.content.find((b) => b.type === "tool_use")!;
    expect(tu).toMatchObject({ type: "tool_use", name: "get_weather", input: { city: "Paris" } });
    const second = await client().messages.create({ model: "mock-fast", max_tokens: 100, tools: [weatherTool], messages: [
      { role: "user", content: "weather in Paris?" },
      { role: "assistant", content: first.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: (tu as { id: string }).id, content: "sunny, 21C" }] },
    ] });
    expect(second.content[0]).toMatchObject({ type: "text", text: "It is sunny in Paris." });
  });

  it("streams a tool call and assembles its JSON input", async () => {
    const stream = client().messages.stream({ model: "mock-fast", max_tokens: 100, tools: [weatherTool], messages: [{ role: "user", content: "weather in Paris?" }] });
    const final = await stream.finalMessage();
    expect(final.stop_reason).toBe("tool_use");
    expect(final.content.find((b) => b.type === "tool_use")).toMatchObject({ name: "get_weather", input: { city: "Paris" } });
  });

  it("surfaces gateway errors as SDK API errors", async () => {
    // Unknown bare models fall back to the default route by design; a pinned unknown provider cannot be routed.
    const err = await client().messages.create({ model: "nosuchprovider/x", max_tokens: 10, messages: [{ role: "user", content: "x" }] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Anthropic.NotFoundError);
    expect((err as InstanceType<typeof Anthropic.APIError>).status).toBe(404);
  });
});

describe("official OpenAI SDK against /v1", () => {
  const client = () => new OpenAI({ apiKey: "unused-local", baseURL: `${base}/v1` });
  const tools = [{ type: "function" as const, function: { name: "get_weather", description: "Weather for a city", parameters: weatherTool.input_schema } }];

  it("creates a chat completion", async () => {
    const r = await client().chat.completions.create({ model: "mock-fast", messages: [{ role: "user", content: "ping" }] });
    expect(r.choices[0]!.message.content).toBe("pong from crucible");
    expect(r.choices[0]!.finish_reason).toBe("stop");
    expect(r.usage!.prompt_tokens).toBeGreaterThan(0);
  });

  it("streams a chat completion", async () => {
    const stream = await client().chat.completions.create({ model: "mock-fast", stream: true, messages: [{ role: "user", content: "ping" }] });
    let text = "", finish: string | null = null;
    for await (const chunk of stream) { text += chunk.choices[0]?.delta?.content ?? ""; finish = chunk.choices[0]?.finish_reason ?? finish; }
    expect(text).toBe("pong from crucible");
    expect(finish).toBe("stop");
  });

  it("round-trips a tool call", async () => {
    const first = await client().chat.completions.create({ model: "mock-fast", tools, messages: [{ role: "user", content: "weather in Paris?" }] });
    const call = first.choices[0]!.message.tool_calls![0]!;
    expect(first.choices[0]!.finish_reason).toBe("tool_calls");
    expect(call.type).toBe("function");
    expect((call as { function: { name: string; arguments: string } }).function.name).toBe("get_weather");
    expect(JSON.parse((call as { function: { arguments: string } }).function.arguments)).toEqual({ city: "Paris" });
    const second = await client().chat.completions.create({ model: "mock-fast", tools, messages: [
      { role: "user", content: "weather in Paris?" },
      first.choices[0]!.message,
      { role: "tool", tool_call_id: call.id, content: "sunny, 21C" },
    ] });
    expect(second.choices[0]!.message.content).toBe("It is sunny in Paris.");
  });

  it("streams a tool call", async () => {
    const stream = await client().chat.completions.create({ model: "mock-fast", stream: true, tools, messages: [{ role: "user", content: "weather in Paris?" }] });
    let args = "", name = "", finish: string | null = null;
    for await (const chunk of stream) {
      const tc = chunk.choices[0]?.delta?.tool_calls?.[0];
      if (tc?.function?.name) name = tc.function.name;
      if (tc?.function?.arguments) args += tc.function.arguments;
      finish = chunk.choices[0]?.finish_reason ?? finish;
    }
    expect(name).toBe("get_weather");
    expect(JSON.parse(args)).toEqual({ city: "Paris" });
    expect(finish).toBe("tool_calls");
  });

  it("lists models and creates embeddings", async () => {
    const models = await client().models.list();
    expect(models.data.some((m) => m.id === "mock-fast")).toBe(true);
    const emb = await client().embeddings.create({ model: "mock-fast", input: ["hello", "world"] });
    expect(emb.data).toHaveLength(2);
    expect(emb.data[0]!.embedding.length).toBeGreaterThan(0);
  });

  it("surfaces gateway errors as SDK API errors", async () => {
    const err = await client().chat.completions.create({ model: "nosuchprovider/x", messages: [{ role: "user", content: "x" }] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenAI.NotFoundError);
    expect((err as InstanceType<typeof OpenAI.APIError>).code).toBe("model_not_found");
  });
});

describe("official OpenAI SDK against /v1/responses (Responses API, used by Codex)", () => {
  const client = () => new OpenAI({ apiKey: "unused-local", baseURL: `${base}/v1` });
  const fnTool = { type: "function" as const, name: "get_weather", description: "Weather for a city", parameters: weatherTool.input_schema, strict: false };

  it("creates a response", async () => {
    const r = await client().responses.create({ model: "mock-fast", instructions: "Be brief.", input: "ping" });
    expect(r.object).toBe("response");
    expect(r.status).toBe("completed");
    expect(r.output_text).toBe("pong from crucible");
    expect(r.usage!.input_tokens).toBeGreaterThan(0);
  });

  it("streams a response and the SDK assembles the final output", async () => {
    const stream = client().responses.stream({ model: "mock-fast", input: [{ role: "user", content: [{ type: "input_text", text: "ping" }] }] });
    let deltas = "";
    stream.on("response.output_text.delta", (e) => { deltas += e.delta; });
    const final = await stream.finalResponse();
    expect(deltas).toBe("pong from crucible");
    expect(final.output_text).toBe("pong from crucible");
    expect(final.status).toBe("completed");
  });

  it("round-trips a function call with call_id and function_call_output", async () => {
    const first = await client().responses.create({ model: "mock-fast", tools: [fnTool], input: "weather in Paris?" });
    const call = first.output.find((o) => o.type === "function_call") as { type: "function_call"; call_id: string; name: string; arguments: string } | undefined;
    expect(call).toBeDefined();
    expect(call!.name).toBe("get_weather");
    expect(JSON.parse(call!.arguments)).toEqual({ city: "Paris" });
    const second = await client().responses.create({ model: "mock-fast", tools: [fnTool], input: [
      { role: "user", content: "weather in Paris?" },
      { type: "function_call", call_id: call!.call_id, name: call!.name, arguments: call!.arguments },
      { type: "function_call_output", call_id: call!.call_id, output: "sunny, 21C" },
    ] });
    expect(second.output_text).toBe("It is sunny in Paris.");
  });

  it("streams a function call", async () => {
    const stream = client().responses.stream({ model: "mock-fast", tools: [fnTool], input: "weather in Paris?" });
    const final = await stream.finalResponse();
    const call = final.output.find((o) => o.type === "function_call") as { name: string; arguments: string } | undefined;
    expect(call?.name).toBe("get_weather");
    expect(JSON.parse(call!.arguments)).toEqual({ city: "Paris" });
  });
});
