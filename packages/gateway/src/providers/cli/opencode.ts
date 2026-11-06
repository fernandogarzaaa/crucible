import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatRequest, ChatResponse } from "@crucible/core";
import type { StreamEvent } from "../../types.js";
import { CliProvider, deltaFor, statusForError, type CliProviderOptions, type ParseState } from "./base.js";
import type { SpawnSpec } from "./run.js";

export interface OpenCodeOptions extends CliProviderOptions {
  /** Path to an opencode.json to use (sets OPENCODE_CONFIG). */
  configPath?: string;
  /** OpenCode agent to run, e.g. "plan" for a read-only agent. */
  agent?: string;
}

const MAX_ARG = 100_000;
const mapStop = (r: string | undefined): ChatResponse["stopReason"] => (r === "length" ? "max_tokens" : "end_turn");

/**
 * OpenCode in `run` mode. Model ids are OpenCode's own `provider/model`, so routes look like
 * `opencode/opencode/glm-5.3-flash-free` (OpenCode Zen free tier, no login needed) or
 * `opencode/openrouter/google/gemma-4-31b-it:free` (OpenRouter free models via OPENROUTER_API_KEY).
 *
 * OpenCode retries rate-limited free models silently, so stderr logs are watched and the run fails
 * fast with a 429, letting a fallback route move on.
 */
export class OpenCodeProvider extends CliProvider {
  readonly name = "opencode";
  protected readonly defaultBin = "opencode";
  protected readonly defaultModels = ["opencode/glm-5.3-flash-free", "opencode/deepseek-v4.1-flash-free", "opencode/nemotron-3.5-lightning-free"];
  constructor(protected readonly ocOpts: OpenCodeOptions = {}) { super(ocOpts); }

  protected spawnSpec(_req: ChatRequest, model: string, workdir: string, p: { system: string | undefined; prompt: string }): SpawnSpec {
    const prompt = p.system ? `Instructions: ${p.system}\n\n${p.prompt}` : p.prompt;
    const args = ["run", "--format", "json", "--pure", "--print-logs", "--log-level", "ERROR", "--dir", workdir];
    if (model && model !== "default") args.push("-m", model);
    if (this.ocOpts.agent) args.push("--agent", this.ocOpts.agent);
    if (prompt.length > MAX_ARG) {
      // Long prompts go through an attached file to stay under the per-argument size limit.
      const file = join(workdir, "prompt.md");
      writeFileSync(file, prompt);
      args.push("-f", file, "--", "Answer the request in the attached file prompt.md. Reply only with the answer.");
    } else {
      args.push("--", prompt);
    }
    const env = this.baseEnv();
    if (this.ocOpts.configPath) env.OPENCODE_CONFIG = this.ocOpts.configPath;
    return { command: this.bin, args, env, cwd: workdir };
  }

  protected parseLine(line: string, s: ParseState): StreamEvent[] {
    const e = JSON.parse(line) as Record<string, any>;
    switch (e.type) {
      case "text": {
        const part = e.part ?? {};
        if (typeof part.text !== "string") return [];
        const d = deltaFor(s, String(part.id ?? "text"), part.text);
        if (!d) return [];
        s.text += d;
        return [{ type: "text_delta", text: d }];
      }
      case "step_finish": {
        const t = e.part?.tokens ?? {};
        s.usage = {
          // Reasoning tokens are billed as output, so count them there (OpenCode reports them separately).
          inputTokens: s.usage.inputTokens + (t.input ?? 0), outputTokens: s.usage.outputTokens + (t.output ?? 0) + (t.reasoning ?? 0),
          cacheReadTokens: (s.usage.cacheReadTokens ?? 0) + (t.cache?.read ?? 0), cacheWriteTokens: (s.usage.cacheWriteTokens ?? 0) + (t.cache?.write ?? 0),
        };
        s.stopReason = mapStop(e.part?.reason);
        if (e.part?.reason === "stop" || e.part?.reason === "length") s.done = true;
        return [];
      }
      case "error": {
        const msg = e.error?.data?.message ?? e.error?.message ?? e.error?.name ?? "error";
        s.error = `opencode: ${msg}`; s.errorStatus = statusForError(msg);
        return [];
      }
      default:
        return [];
    }
  }

  protected parseStderr(line: string, s: ParseState): string | null {
    if (/Free usage limit reached/i.test(line)) { s.errorStatus = 429; return "opencode: free usage limit reached for this model (rate limited)"; }
    // Errors from the title-generation side request (small=true) are noise; main-request errors are fatal.
    if (/level=ERROR/.test(line) && /message="stream error"/.test(line) && !/small=true/.test(line)) {
      const m = /error\.error="([^"]+)/.exec(line)?.[1] ?? "stream error";
      s.errorStatus = statusForError(m);
      return `opencode: ${m}`;
    }
    return null;
  }
}
