import { capture, stripAnsi, which } from "./run.js";

export type CliName = "claude-code" | "codex" | "opencode" | "cline";

export interface CliStatus {
  name: CliName;
  bin: string;
  installed: boolean;
  version: string | null;
  /** true/false when the CLI can report it, null when it cannot be checked non-interactively. */
  loggedIn: boolean | null;
  detail: string;
  /** Command the user runs (in their own terminal) to sign in. */
  loginCommand: string;
  purpose: "subscription" | "free-models";
}

const BINS: Record<CliName, string> = { "claude-code": "claude", codex: "codex", opencode: "opencode", cline: "cline" };

export const LOGIN: Record<CliName, { args: string[]; display: string }> = {
  "claude-code": { args: ["auth", "login"], display: "claude auth login" },
  codex: { args: ["login"], display: "codex login   (add --device-auth on a headless machine)" },
  opencode: { args: ["providers", "login"], display: "opencode providers login   (optional: Zen free models need no login)" },
  cline: { args: ["auth"], display: "cline auth   (or set OPENROUTER_API_KEY for OpenRouter free models)" },
};

async function version(bin: string): Promise<string | null> {
  const r = await capture(bin, ["--version"], { timeoutMs: 15_000 });
  return r.code === 0 ? stripAnsi(r.stdout || r.stderr).trim().split("\n")[0] ?? null : null;
}

export async function cliStatus(name: CliName, bin = BINS[name]): Promise<CliStatus> {
  const base = { name, bin, loginCommand: LOGIN[name].display, purpose: (name === "claude-code" || name === "codex" ? "subscription" : "free-models") as CliStatus["purpose"] };
  if (!which(bin)) return { ...base, installed: false, version: null, loggedIn: false, detail: `not installed (${installHint(name)})` };
  const v = await version(bin);
  switch (name) {
    case "claude-code": {
      const r = await capture(bin, ["auth", "status"], { timeoutMs: 20_000 });
      try {
        const s = JSON.parse(r.stdout) as { loggedIn?: boolean; authMethod?: string; apiProvider?: string; subscriptionType?: string };
        const via = s.subscriptionType ? `${s.subscriptionType} subscription` : s.authMethod ?? "unknown method";
        return { ...base, installed: true, version: v, loggedIn: !!s.loggedIn, detail: s.loggedIn ? `signed in via ${via}${process.env.ANTHROPIC_API_KEY ? "; ANTHROPIC_API_KEY is set in Crucible's environment but is removed for these calls so the subscription is used" : ""}` : "not signed in" };
      } catch {
        return { ...base, installed: true, version: v, loggedIn: null, detail: stripAnsi(r.stdout || r.stderr).trim().slice(0, 200) || "could not read auth status" };
      }
    }
    case "codex": {
      const r = await capture(bin, ["login", "status"], { timeoutMs: 20_000 });
      const out = stripAnsi(`${r.stdout}\n${r.stderr}`).trim();
      const loggedIn = /logged in/i.test(out) && !/not logged in/i.test(out);
      return { ...base, installed: true, version: v, loggedIn, detail: out.split("\n").find((l) => /logged in/i.test(l))?.trim() ?? (out.slice(0, 200) || "unknown") };
    }
    case "opencode":
      return { ...base, installed: true, version: v, loggedIn: true, detail: "OpenCode Zen free models need no login; add provider keys with `opencode providers login` or env vars such as OPENROUTER_API_KEY" };
    case "cline":
      return { ...base, installed: true, version: v, loggedIn: null, detail: process.env.OPENROUTER_API_KEY ? "OPENROUTER_API_KEY is set: OpenRouter free models are available" : "configure a provider with `cline auth`, or set OPENROUTER_API_KEY for OpenRouter free models (cline cannot report auth status without a terminal)" };
  }
}

export async function allCliStatus(bins: Partial<Record<CliName, string>> = {}): Promise<CliStatus[]> {
  return Promise.all((Object.keys(BINS) as CliName[]).map((n) => cliStatus(n, bins[n] ?? BINS[n])));
}

export function installHint(name: CliName): string {
  switch (name) {
    case "claude-code": return "npm i -g @anthropic-ai/claude-code";
    case "codex": return "npm i -g @openai/codex";
    case "opencode": return "npm i -g opencode-ai";
    case "cline": return "npm i -g cline";
  }
}

export const cliBinary = (name: CliName) => BINS[name];
