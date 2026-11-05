import { AnthropicProvider } from "./providers/anthropic.js";
import { demoProvider } from "./providers/demo.js";
import { OpenAICompatibleProvider } from "./providers/openai.js";
import type { Provider } from "./types.js";

/** Build providers from environment variables. The mock provider is always present for demos/tests. */
export function providersFromEnv(env: NodeJS.ProcessEnv = process.env): Provider[] {
  const out: Provider[] = [];
  if (env.ANTHROPIC_API_KEY) out.push(new AnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY, baseUrl: env.ANTHROPIC_BASE_URL }));
  if (env.OPENAI_API_KEY) out.push(new OpenAICompatibleProvider({ apiKey: env.OPENAI_API_KEY, baseUrl: env.OPENAI_BASE_URL }));
  if (env.OLLAMA_BASE_URL) out.push(new OpenAICompatibleProvider({ name: "ollama", baseUrl: env.OLLAMA_BASE_URL, apiKey: "ollama", models: [], supportsModel: () => false }));
  if (env.GROQ_API_KEY) out.push(new OpenAICompatibleProvider({ name: "groq", baseUrl: "https://api.groq.com/openai/v1", apiKey: env.GROQ_API_KEY, models: [], supportsModel: () => false }));
  if (env.OPENROUTER_API_KEY) out.push(new OpenAICompatibleProvider({ name: "openrouter", baseUrl: "https://openrouter.ai/api/v1", apiKey: env.OPENROUTER_API_KEY, models: [], supportsModel: () => false }));
  out.push(demoProvider());
  return out;
}
