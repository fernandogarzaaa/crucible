import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

export interface SpawnSpec {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Written to the child's stdin, which is then closed. Omit to close stdin immediately. */
  stdin?: string;
}

export interface RunLimits {
  /** Hard ceiling for the whole run. */
  timeoutMs: number;
  /** Kill the process if it produces no stdout for this long (catches silent retry loops). */
  idleTimeoutMs: number;
  signal?: AbortSignal;
}

export type RunEvent =
  | { kind: "stdout"; line: string }
  | { kind: "stderr"; line: string }
  | { kind: "exit"; code: number | null; reason: "exited" | "timeout" | "idle" | "aborted" | "spawn_error"; error?: string };

/**
 * Spawn a CLI and yield its stdout and stderr line by line, then a single exit event.
 * The process (and its process group) is killed on timeout, idle timeout, abort, or when the
 * consumer stops iterating, so a wrapped agent can never outlive the request that started it.
 */
export async function* runLines(spec: SpawnSpec, limits: RunLimits): AsyncGenerator<RunEvent> {
  const queue: RunEvent[] = [];
  let wake: (() => void) | null = null;
  const push = (e: RunEvent) => { queue.push(e); wake?.(); wake = null; };

  let child;
  try {
    child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  } catch (err) {
    yield { kind: "exit", code: null, reason: "spawn_error", error: (err as Error).message };
    return;
  }
  let finished = false;
  let reason: Extract<RunEvent, { kind: "exit" }>["reason"] = "exited";
  const kill = (why: typeof reason) => {
    if (finished) return;
    reason = why;
    try { process.kill(-child.pid!, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch { /* gone */ } }
    setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } }, 2000).unref();
  };

  const hard = setTimeout(() => kill("timeout"), limits.timeoutMs);
  let idle = setTimeout(() => kill("idle"), limits.idleTimeoutMs);
  const touch = () => { clearTimeout(idle); idle = setTimeout(() => kill("idle"), limits.idleTimeoutMs); };
  const onAbort = () => kill("aborted");
  limits.signal?.addEventListener("abort", onAbort, { once: true });

  const splitter = (kind: "stdout" | "stderr") => {
    let buf = "";
    return (chunk: Buffer) => {
      if (kind === "stdout") touch();
      buf += chunk.toString("utf8");
      let i: number;
      while ((i = buf.indexOf("\n")) !== -1) { const line = buf.slice(0, i).replace(/\r$/, ""); buf = buf.slice(i + 1); if (line) push({ kind, line }); }
    };
  };
  child.stdout!.on("data", splitter("stdout"));
  child.stderr!.on("data", splitter("stderr"));
  child.on("error", (err) => { finished = true; push({ kind: "exit", code: null, reason: "spawn_error", error: err.message }); });
  child.on("close", (code) => { if (finished) return; finished = true; push({ kind: "exit", code, reason }); });
  child.stdin!.on("error", () => { /* child may exit before reading stdin */ });
  child.stdin!.end(spec.stdin ?? "");

  try {
    while (true) {
      if (!queue.length) await new Promise<void>((r) => { wake = r; });
      const e = queue.shift()!;
      yield e;
      if (e.kind === "exit") return;
    }
  } finally {
    clearTimeout(hard); clearTimeout(idle);
    limits.signal?.removeEventListener("abort", onAbort);
    if (!finished) kill("aborted");
  }
}

/** Resolve a command name against PATH without spawning anything. */
export function which(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (command.includes("/")) { try { accessSync(command, constants.X_OK); return command; } catch { return null; } }
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, command);
    try { accessSync(p, constants.X_OK); return p; } catch { /* keep looking */ }
  }
  return null;
}

/** Run a short command and capture its output (for status checks and model discovery). */
export async function capture(command: string, args: string[], opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv; cwd?: string } = {}): Promise<{ code: number | null; stdout: string; stderr: string; reason: string }> {
  let stdout = "", stderr = "", code: number | null = null, reason = "exited";
  for await (const e of runLines({ command, args, env: opts.env ?? process.env, cwd: opts.cwd ?? process.cwd() }, { timeoutMs: opts.timeoutMs ?? 15_000, idleTimeoutMs: opts.timeoutMs ?? 15_000 })) {
    if (e.kind === "stdout") stdout += e.line + "\n";
    else if (e.kind === "stderr") stderr += e.line + "\n";
    else { code = e.code; reason = e.reason; }
  }
  return { code, stdout, stderr, reason };
}

/** Strip ANSI colour codes from CLI output. */
export const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
