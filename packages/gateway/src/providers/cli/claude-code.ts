import type { ChatRequest, ChatResponse } from "@crucible/core";
import type { StreamEvent } from "../../types.js";
import { CliProvider, statusForError, type CliProviderOptions, type ParseState } from "./base.js";
import type { SpawnSpec } from "./run.js";

export interface ClaudeCodeOptions extends CliProviderOptions {
  /**
   * Keep ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN in the child environment. Off by default: when an
   * API key is present Claude Code bills the API instead of the signed-in subscription.
   */
  allowApiKey?: boolean;
}

const mapStop = (s: string | null | undefined): ChatResponse["stopReason"] =>
  s === "max_tokens" ? "max_tokens" : s === "stop_sequence" ? "stop_sequence" : "end_turn";

/**
 * Claude Code in headless print mode, authenticated with whatever `claude auth login` set up
 * (Claude Pro/Max subscription or a Console account). Tools, MCP servers and user settings are
 * disabled for each call, and the agent system prompt is replaced, so it behaves as a plain model.
 *
 * Models: `claude-code/sonnet`, `claude-code/opus`, `claude-code/haiku`, or any full model id.
 */
export class ClaudeCodeProvider extends CliProvider {
  readonly name = "claude-code";
  protected readonly defaultBin = "claude";
  protected readonly defaultModels = ["sonnet", "opus", "haiku"];
  constructor(protected readonly claudeOpts: ClaudeCodeOptions = {}) { super(claudeOpts); }

  protected spawnSpec(_req: ChatRequest, model: string, workdir: string, p: { system: string | undefined; prompt: string }): SpawnSpec {
    const args = [
      "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--input-format", "text",
      "--no-session-persistence", "--tools", "", "--strict-mcp-config", "--setting-sources", "",
      "--system-prompt", p.system ?? "You are a helpful assistant. Answer the user directly.",
    ];
    if (model && model !== "default") args.push("--model", model);
    const env = this.baseEnv(this.claudeOpts.allowApiKey ? [] : ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]);
    return { command: this.bin, args, env, cwd: workdir, stdin: p.prompt };
  }

  protected parseLine(line: string, s: ParseState): StreamEvent[] {
    const e = JSON.parse(line) as Record<string, any>;
    switch (e.type) {
      case "system":
        if (e.subtype === "init" && e.model) s.servedModel = e.model;
        return [];
      case "stream_event": {
        const ev = e.event ?? {};
        if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) { s.text += ev.delta.text; return [{ type: "text_delta", text: ev.delta.text }]; }
        if (ev.type === "message_delta" && ev.delta?.stop_reason) s.stopReason = mapStop(ev.delta.stop_reason);
        return [];
      }
      case "result": {
        const u = e.usage ?? {};
        s.usage = { inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0, cacheReadTokens: u.cache_read_input_tokens, cacheWriteTokens: u.cache_creation_input_tokens };
        if (e.is_error || (e.subtype && e.subtype !== "success")) {
          const msg = typeof e.result === "string" && e.result ? e.result : `claude-code: ${e.subtype ?? "error"}`;
          s.error = `claude-code: ${msg}`; s.errorStatus = statusForError(msg);
          return [];
        }
        s.stopReason = mapStop(e.stop_reason);
        s.done = true;
        // Without partial messages the text only arrives here.
        if (!s.text && typeof e.result === "string" && e.result) { s.text = e.result; return [{ type: "text_delta", text: e.result }]; }
        return [];
      }
      default:
        return [];
    }
  }
}
