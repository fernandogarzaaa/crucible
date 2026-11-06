import { AnthropicProvider } from "./providers/anthropic.js";
import { demoProvider } from "./providers/demo.js";
import { OpenAICompatibleProvider } from "./providers/openai.js";
import type { Provider } from "./types.js";
import { ClaudeCodeProvider } from "./providers/cli/claude-code.js";
import { ClineProvider } from "./providers/cli/cline.js";
import { CodexProvider } from "./providers/cli/codex.js";
import { OpenCodeProvider } from "./providers/cli/opencode.js";

/** Build providers from environment variables. The mock provider is always present for demos/tests. */
export function providersFromEnv(env: NodeJS.ProcessEnv = process.env): Provider[] {
  const out: Provider[] = [];
  if (env.ANTHROPIC_API_KEY) out.push(new AnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY, baseUrl: env.ANTHROPIC_BASE_URL }));
  if (env.OPENAI_API_KEY) out.push(new OpenAICompatibleProvider({ apiKey: env.OPENAI_API_KEY, baseUrl: env.OPENAI_BASE_URL }));
  if (env.OLLAMA_BASE_URL) out.push(new OpenAICompatibleProvider({ name: "ollama", baseUrl: env.OLLAMA_BASE_URL, apiKey: "ollama", models: [], supportsModel: () => false }));
  if (env.GROQ_API_KEY) out.push(new OpenAICompatibleProvider({ name: "groq", baseUrl: "https://api.groq.com/openai/v1", apiKey: env.GROQ_API_KEY, models: [], supportsModel: () => false }));
  if (env.OPENROUTER_API_KEY) out.push(new OpenAICompatibleProvider({ name: "openrouter", baseUrl: "https://openrouter.ai/api/v1", apiKey: env.OPENROUTER_API_KEY, models: [], supportsModel: () => false }));
  // Vendor CLIs on PATH become providers (subscription logins and free tiers). They are used only when
  // pinned (`claude-code/sonnet`) or named in a route, never for bare model ids. CRUCIBLE_CLI_PROVIDERS=off disables.
  if (env.CRUCIBLE_CLI_PROVIDERS !== "off") {
    const timeoutMs = env.CRUCIBLE_CLI_TIMEOUT_MS ? Number(env.CRUCIBLE_CLI_TIMEOUT_MS) : undefined;
    const idleTimeoutMs = env.CRUCIBLE_CLI_IDLE_MS ? Number(env.CRUCIBLE_CLI_IDLE_MS) : undefined;
    const common = { timeoutMs, idleTimeoutMs };
    for (const p of [
      new ClaudeCodeProvider({ ...common, bin: env.CRUCIBLE_CLAUDE_BIN, allowApiKey: env.CRUCIBLE_CLAUDE_ALLOW_API_KEY === "1" }),
      new CodexProvider({ ...common, bin: env.CRUCIBLE_CODEX_BIN, allowApiKey: env.CRUCIBLE_CODEX_ALLOW_API_KEY === "1" }),
      new OpenCodeProvider({ ...common, bin: env.CRUCIBLE_OPENCODE_BIN, configPath: env.CRUCIBLE_OPENCODE_CONFIG }),
      new ClineProvider({ ...common, bin: env.CRUCIBLE_CLINE_BIN, dataDir: env.CRUCIBLE_CLINE_DATA_DIR }),
    ]) if (p.installed()) out.push(p);
  }
  out.push(demoProvider());
  return out;
}
