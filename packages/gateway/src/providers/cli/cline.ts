import type { ChatRequest } from "@crucible/core";
import type { StreamEvent } from "../../types.js";
import { CliProvider, statusForError, type CliProviderOptions, type ParseState } from "./base.js";
import type { SpawnSpec } from "./run.js";

export interface ClineOptions extends CliProviderOptions {
  /** Isolated Cline state directory (--data-dir). Defaults to the user's own ~/.cline, so `cline auth` logins apply. */
  dataDir?: string;
  /**
   * Environment variables holding API keys per Cline provider id, passed with `-k` for that run.
   * Default: { openrouter: "OPENROUTER_API_KEY" }. Note that Cline saves a key passed this way.
   */
  keyEnv?: Record<string, string>;
}

/**
 * Cline CLI in headless JSON mode. Model ids are `<cline provider>/<model>`, e.g.
 * `cline/openrouter/google/gemma-4-31b-it:free` (OpenRouter free tier) or
 * `cline/cline/<model>` (Cline account models, after `cline auth`). Bare models use Cline's
 * configured default provider.
 */
export class ClineProvider extends CliProvider {
  readonly name = "cline";
  protected readonly defaultBin = "cline";
  protected readonly defaultModels = ["openrouter/google/gemma-4-31b-it:free", "openrouter/nvidia/nemotron-3.5-lightning:free"];
  constructor(protected readonly clineOpts: ClineOptions = {}) { super(clineOpts); }

  protected spawnSpec(_req: ChatRequest, model: string, workdir: string, p: { system: string | undefined; prompt: string }): SpawnSpec {
    const args = ["--json", "-c", workdir, "--retries", "1", "--compaction", "off", "--auto-approve", "false",
      "-s", p.system ?? "You are a helpful assistant. Answer the user directly and do not use tools."];
    if (this.clineOpts.dataDir) args.push("--data-dir", this.clineOpts.dataDir);
    const timeoutSec = Math.ceil((this.opts.timeoutMs ?? 600_000) / 1000);
    args.push("--timeout", String(timeoutSec));
    const env = this.baseEnv();
    if (model && model !== "default") {
      const slash = model.indexOf("/");
      const provider = slash > 0 ? model.slice(0, slash) : undefined;
      const id = slash > 0 ? model.slice(slash + 1) : model;
      if (provider) {
        args.push("-P", provider);
        const keyVar = (this.clineOpts.keyEnv ?? { openrouter: "OPENROUTER_API_KEY" })[provider];
        if (keyVar && env[keyVar]) args.push("-k", env[keyVar]!);
      }
      args.push("-m", id);
    }
    // Cline rejects a bare single word as an "unquoted prompt"; any whitespace avoids that.
    const prompt = /\s/.test(p.prompt) ? p.prompt : `User: ${p.prompt}`;
    args.push(prompt);
    return { command: this.bin, args, env, cwd: workdir };
  }

  protected parseLine(line: string, s: ParseState): StreamEvent[] {
    const e = JSON.parse(line) as Record<string, any>;
    if (e.type === "agent_event") {
      const ev = e.event ?? {};
      if (ev.type === "content_start" && ev.contentType === "text") {
        const full = typeof ev.accumulated === "string" ? ev.accumulated : s.text + (ev.text ?? "");
        if (!full.startsWith(s.text)) return [];
        const d = full.slice(s.text.length);
        if (!d) return [];
        s.text = full;
        return [{ type: "text_delta", text: d }];
      }
      if (ev.type === "error") {
        const msg = ev.error?.message ?? "error";
        s.errorStatus = ev.errorClass === "auth" ? 401 : statusForError(msg);
        if (ev.recoverable === false) s.error = `cline: ${msg}`;
      }
      return [];
    }
    if (e.type === "run_result") {
      const u = e.aggregateUsage ?? e.usage ?? {};
      s.usage = { inputTokens: u.inputTokens ?? 0, outputTokens: u.outputTokens ?? 0, cacheReadTokens: u.cacheReadTokens, cacheWriteTokens: u.cacheWriteTokens };
      if (e.model?.id) s.servedModel = e.model.id;
      if (e.finishReason === "completed") {
        s.done = true;
        // The final text is authoritative; emit anything the streamed chunks missed.
        if (typeof e.text === "string" && e.text.startsWith(s.text) && e.text.length > s.text.length) {
          const d = e.text.slice(s.text.length); s.text = e.text; return [{ type: "text_delta", text: d }];
        }
        return [];
      }
      const msg = typeof e.text === "string" && e.text ? e.text : e.finishReason ?? "failed";
      s.error = `cline: ${msg}`;
      if (s.errorStatus === 502) s.errorStatus = statusForError(msg);
      return [];
    }
    if (e.type === "error") {
      const msg = e.message ?? "error";
      if (!s.error) { s.error = `cline: ${msg}`; if (s.errorStatus === 502) s.errorStatus = statusForError(msg); }
    }
    return [];
  }
}
