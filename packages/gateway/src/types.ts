import type { ChatRequest, ChatResponse, Message, Usage } from "@crucible/core";

/** Normalized streaming events emitted by every provider. */
export type StreamEvent =
  | { type: "start"; id: string; model: string }
  | { type: "text_delta"; text: string }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_use_delta"; id: string; inputJsonDelta: string }
  | { type: "tool_use_end"; id: string }
  | { type: "usage"; usage: Partial<Usage> }
  | { type: "end"; stopReason: ChatResponse["stopReason"]; message: Message; usage: Usage }
  | { type: "error"; error: string };

export interface Provider {
  readonly name: string;
  /** Models this provider can serve. Used by the router for `provider/model` resolution and by the UI. */
  models(): string[];
  supports(model: string): boolean;
  chat(req: ChatRequest, signal?: AbortSignal): Promise<Omit<ChatResponse, "costUsd" | "cached" | "latencyMs">>;
  stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent>;
  embed?(model: string, inputs: string[], signal?: AbortSignal): Promise<{ embeddings: number[][]; usage: Usage }>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export const isRetryableStatus = (s: number) => s === 408 || s === 409 || s === 429 || s >= 500;
