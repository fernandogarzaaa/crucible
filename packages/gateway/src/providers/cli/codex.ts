import type { ChatRequest } from "@crucible/core";
import type { StreamEvent } from "../../types.js";
import { CliProvider, deltaFor, statusForError, type CliProviderOptions, type ParseState } from "./base.js";
import type { SpawnSpec } from "./run.js";

export interface CodexOptions extends CliProviderOptions {
  /** Keep OPENAI_API_KEY in the child environment. Off by default so the ChatGPT login is used. */
  allowApiKey?: boolean;
  /** CODEX_HOME to use (defaults to the user's ~/.codex, where `codex login` stores credentials). */
  codexHome?: string;
  /** Extra `-c key=value` overrides, e.g. a custom model provider. */
  config?: string[];
}

/**
 * OpenAI Codex CLI in `exec` mode, authenticated with `codex login` (ChatGPT Plus/Pro/Team
 * subscription or an API key). Runs read-only, ephemeral, in an empty scratch directory.
 *
 * Models: `codex/default` uses the CLI's configured model; `codex/<model>` passes `-m <model>`.
 */
export class CodexProvider extends CliProvider {
  readonly name = "codex";
  protected readonly defaultBin = "codex";
  protected readonly defaultModels = ["default"];
  constructor(protected readonly codexOpts: CodexOptions = {}) { super(codexOpts); }

  protected spawnSpec(_req: ChatRequest, model: string, workdir: string, p: { system: string | undefined; prompt: string }): SpawnSpec {
    const args = ["exec", "--json", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only", "--color", "never", "-C", workdir];
    for (const c of this.codexOpts.config ?? []) args.push("-c", c);
    if (model && model !== "default") args.push("-m", model);
    args.push("-"); // prompt from stdin
    const env = this.baseEnv(this.codexOpts.allowApiKey ? [] : ["OPENAI_API_KEY"]);
    if (this.codexOpts.codexHome) env.CODEX_HOME = this.codexOpts.codexHome;
    const prompt = p.system ? `Instructions: ${p.system}\n\n${p.prompt}` : p.prompt;
    return { command: this.bin, args, env, cwd: workdir, stdin: prompt };
  }

  protected parseLine(line: string, s: ParseState): StreamEvent[] {
    const e = JSON.parse(line) as Record<string, any>;
    switch (e.type) {
      case "item.started":
      case "item.updated":
      case "item.completed": {
        const item = e.item ?? {};
        if (item.type !== "agent_message" || typeof item.text !== "string") return [];
        const d = deltaFor(s, String(item.id ?? "msg"), item.text);
        if (!d) return [];
        s.text += d;
        return [{ type: "text_delta", text: d }];
      }
      case "turn.completed": {
        const u = e.usage ?? {};
        s.usage = { inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0, cacheReadTokens: u.cached_input_tokens };
        s.done = true;
        return [];
      }
      case "turn.failed": {
        const msg = e.error?.message ?? "turn failed";
        s.error = `codex: ${msg}`; s.errorStatus = statusForError(msg);
        return [];
      }
      case "error": {
        // Codex reports transient reconnects as `error` events; only a turn.failed or a non-zero exit ends the run.
        return [];
      }
      default:
        return [];
    }
  }
}
