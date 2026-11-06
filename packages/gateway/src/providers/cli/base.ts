import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatRequest, ChatResponse, ContentPart, Message, Usage } from "@crucible/core";
import { ProviderError, type Provider, type StreamEvent } from "../../types.js";
import { runLines, which, type SpawnSpec } from "./run.js";

export interface CliProviderOptions {
  /** Path or name of the CLI binary. */
  bin?: string;
  /** Hard ceiling per request. Default 10 minutes. */
  timeoutMs?: number;
  /** Fail if the CLI prints nothing for this long. Default 90 seconds. */
  idleTimeoutMs?: number;
  /** Extra environment for the child process. */
  env?: Record<string, string>;
  /** Models to advertise in /v1/models and the UI. */
  models?: string[];
  /** Keep the per-request scratch directory for debugging. */
  keepWorkdir?: boolean;
}

/** Mutable state a CLI parser carries across lines. */
export interface ParseState {
  text: string;
  usage: Usage;
  stopReason: ChatResponse["stopReason"];
  done: boolean;
  error: string | null;
  errorStatus: number;
  /** Per-part text already emitted (for CLIs that resend whole parts). */
  emitted: Map<string, string>;
  servedModel?: string;
}

export const newState = (): ParseState => ({ text: "", usage: { inputTokens: 0, outputTokens: 0 }, stopReason: "end_turn", done: false, error: null, errorStatus: 502, emitted: new Map() });

const textOf = (m: Message): string =>
  typeof m.content === "string"
    ? m.content
    : m.content.map((p: ContentPart) => {
        switch (p.type) {
          case "text": return p.text;
          case "tool_use": return `[called tool ${p.name} with ${JSON.stringify(p.input)}]`;
          case "tool_result": return `[tool result${p.isError ? " (error)" : ""}: ${p.content}]`;
          case "image": return "[image]";
        }
      }).join("\n");

/**
 * Coding-agent CLIs take one prompt, not a message list. A single user turn is sent as-is;
 * a conversation is rendered as a labelled transcript with an instruction to answer the last turn.
 */
export function renderTranscript(messages: Message[]): { system: string | undefined; prompt: string } {
  const system = messages.filter((m) => m.role === "system").map(textOf).join("\n\n") || undefined;
  const turns = messages.filter((m) => m.role !== "system");
  if (turns.length === 1 && turns[0]!.role === "user") return { system, prompt: textOf(turns[0]!) };
  const body = turns.map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${textOf(m)}`).join("\n\n");
  return { system, prompt: `Continue the conversation below. Reply only with the assistant's next message to the final user turn.\n\n<conversation>\n${body}\n</conversation>` };
}

/**
 * Base class for providers that drive a vendor CLI as a subprocess. The CLI keeps its own login
 * (subscription OAuth, free tier, saved provider keys); Crucible never reads or copies those
 * credentials. Each request runs in a fresh empty scratch directory with tools disabled where the
 * CLI allows it, so the wrapped agent answers instead of acting.
 */
export abstract class CliProvider implements Provider {
  abstract readonly name: string;
  protected abstract readonly defaultBin: string;
  protected abstract readonly defaultModels: string[];
  protected readonly opts: CliProviderOptions;

  constructor(opts: CliProviderOptions = {}) {
    this.opts = opts;
  }

  get bin(): string { return this.opts.bin ?? this.defaultBin; }
  installed(): boolean { return which(this.bin) !== null; }
  models(): string[] { return this.opts.models ?? this.defaultModels; }
  /** CLI providers are only used when pinned (`name/model`) or named in a route, never for bare model ids. */
  supports(_model: string): boolean { return false; }

  /** Build the command line for one request. */
  protected abstract spawnSpec(req: ChatRequest, model: string, workdir: string, prompt: { system: string | undefined; prompt: string }): SpawnSpec;
  /** Turn one stdout line into zero or more stream events, updating state. */
  protected abstract parseLine(line: string, state: ParseState): StreamEvent[];
  /** Inspect a stderr line; return an error message to fail fast, or null. */
  protected parseStderr(_line: string, _state: ParseState): string | null { return null; }

  protected baseEnv(remove: string[] = []): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, ...(this.opts.env ?? {}), NO_COLOR: "1", FORCE_COLOR: "0" };
    for (const k of remove) delete env[k];
    return env;
  }

  private validate(req: ChatRequest) {
    if (req.config.tools?.length) {
      throw new ProviderError(`${this.name}: tool calling is not supported through a CLI provider; route tool-using requests to an API provider`, this.name, 400, false);
    }
    const hasImage = req.messages.some((m) => typeof m.content !== "string" && m.content.some((p) => p.type === "image"));
    if (hasImage) throw new ProviderError(`${this.name}: image input is not supported through a CLI provider`, this.name, 400, false);
  }

  async *stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    this.validate(req);
    if (!this.installed()) throw new ProviderError(`${this.name}: "${this.bin}" is not installed or not on PATH`, this.name, 503, false);
    const model = req.config.model;
    const workdir = mkdtempSync(join(tmpdir(), `crucible-${this.name}-`));
    const state = newState();
    const spec = this.spawnSpec(req, model, workdir, renderTranscript(req.messages));
    let started = false;
    const stderrTail: string[] = [];
    try {
      for await (const ev of runLines(spec, { timeoutMs: this.opts.timeoutMs ?? 600_000, idleTimeoutMs: this.opts.idleTimeoutMs ?? 90_000, signal })) {
        if (ev.kind === "stdout") {
          let out: StreamEvent[] = [];
          try { out = this.parseLine(ev.line, state); } catch { /* non-JSON noise from the CLI */ }
          for (const o of out) {
            if (!started) { started = true; yield { type: "start", id: `${this.name}_${Date.now()}`, model: state.servedModel ?? model }; }
            yield o;
          }
          if (state.error) break;
        } else if (ev.kind === "stderr") {
          stderrTail.push(ev.line);
          if (stderrTail.length > 20) stderrTail.shift();
          const fatal = this.parseStderr(ev.line, state);
          if (fatal) { state.error = fatal; break; }
        } else {
          if (state.error) break;
          if (ev.reason !== "exited") {
            const why = ev.reason === "idle" ? `produced no output for ${Math.round((this.opts.idleTimeoutMs ?? 90_000) / 1000)}s` : ev.reason === "timeout" ? "timed out" : ev.reason === "aborted" ? "was aborted" : `could not start: ${ev.error}`;
            state.error = `${this.name}: ${why}${stderrTail.length ? ` (last stderr: ${stderrTail.slice(-2).join(" | ").slice(0, 300)})` : ""}`;
            state.errorStatus = ev.reason === "spawn_error" ? 503 : 504;
          } else if (ev.code !== 0 && !state.done) {
            state.error = `${this.name}: exited with code ${ev.code}${stderrTail.length ? `: ${stderrTail.slice(-3).join(" | ").slice(0, 400)}` : ""}`;
          } else if (!state.done && !state.text) {
            state.error = `${this.name}: finished without a response${stderrTail.length ? ` (${stderrTail.slice(-2).join(" | ").slice(0, 300)})` : ""}`;
          }
        }
      }
    } finally {
      if (!this.opts.keepWorkdir) rmSync(workdir, { recursive: true, force: true });
    }
    if (state.error) {
      // Rate limits and auth failures should move a fallback route on to its next target.
      throw new ProviderError(state.error, this.name, state.errorStatus, state.errorStatus === 502 && !started);
    }
    if (!started) yield { type: "start", id: `${this.name}_${Date.now()}`, model: state.servedModel ?? model };
    yield { type: "end", stopReason: state.stopReason, message: { role: "assistant", content: state.text }, usage: state.usage };
  }

  async chat(req: ChatRequest, signal?: AbortSignal) {
    let id = "", model = req.config.model;
    for await (const ev of this.stream(req, signal)) {
      if (ev.type === "start") { id = ev.id; model = ev.model; }
      if (ev.type === "end") return { id, model, provider: this.name, message: ev.message, stopReason: ev.stopReason, usage: ev.usage };
    }
    throw new ProviderError(`${this.name}: no response`, this.name, 502, true);
  }
}

/** Emit only the unseen suffix of a part whose full text the CLI resends on every update. */
export function deltaFor(state: ParseState, partId: string, fullText: string): string {
  const prev = state.emitted.get(partId) ?? "";
  if (!fullText.startsWith(prev)) { state.emitted.set(partId, fullText); return fullText; }
  state.emitted.set(partId, fullText);
  return fullText.slice(prev.length);
}

/** Classify an error message from any CLI into an HTTP-ish status for routing decisions. */
export function statusForError(message: string): number {
  const m = message.toLowerCase();
  if (/rate.?limit|usage limit|quota|too many requests|429|limit reached/.test(m)) return 429;
  if (/not logged in|unauthori[sz]ed|authentication|api key|401|403|log ?in|credential/.test(m)) return 401;
  if (/not found|unknown model|404|invalid model|model .* not/.test(m)) return 404;
  return 502;
}
