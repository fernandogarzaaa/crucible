#!/usr/bin/env node
// Test double for vendor CLIs: replays a recorded JSONL fixture and records how it was invoked.
import { appendFileSync, readFileSync } from "node:fs";
const env = process.env;
let stdin = "";
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", async () => {
  if (env.FAKE_RECORD) appendFileSync(env.FAKE_RECORD, JSON.stringify({ argv: process.argv.slice(2), stdin, cwd: process.cwd(), hasAnthropicKey: !!env.ANTHROPIC_API_KEY, hasOpenAIKey: !!env.OPENAI_API_KEY, noColor: env.NO_COLOR }) + "\n");
  if (env.FAKE_STDERR) process.stderr.write(readFileSync(env.FAKE_STDERR, "utf8"));
  if (env.FAKE_HANG === "1") { setInterval(() => {}, 1000); return; }
  if (env.FAKE_FIXTURE) {
    for (const line of readFileSync(env.FAKE_FIXTURE, "utf8").split("\n").filter(Boolean)) {
      process.stdout.write(line + "\n");
      if (env.FAKE_DELAY_MS) await new Promise((r) => setTimeout(r, Number(env.FAKE_DELAY_MS)));
    }
  }
  if (env.FAKE_HANG_AFTER === "1") { setInterval(() => {}, 1000); return; }
  process.exit(Number(env.FAKE_EXIT ?? 0));
});
