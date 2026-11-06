import { MessageChannel, Worker, receiveMessageOnPort, type MessagePort } from "node:worker_threads";

/**
 * Runs an async driver (node-postgres or PGlite) inside a worker thread and exposes it synchronously
 * to the main thread with Atomics.wait + receiveMessageOnPort. This is the same technique used by
 * synckit and esbuild's sync APIs. It costs roughly 50-150µs per query, which is far below the cost
 * of the network round-trip to Postgres itself, and it lets every repository stay synchronous.
 */
export class SyncBridge {
  private readonly worker: Worker;
  private readonly port: MessagePort;
  private readonly flag: Int32Array;
  private closed = false;

  constructor(workerUrl: URL, init: unknown) {
    const sab = new SharedArrayBuffer(4);
    this.flag = new Int32Array(sab);
    const { port1, port2 } = new MessageChannel();
    this.port = port1;
    this.worker = new Worker(workerUrl, { workerData: { port: port2, sab, init }, transferList: [port2] });
    this.worker.on("error", (err) => { console.error("[crucible] database worker crashed:", err); });
    this.worker.unref();
    // Block until the worker reports that it connected (or failed to).
    this.call("__ready", []);
  }

  call<T = unknown>(method: string, args: unknown[], timeoutMs = 120_000): T {
    if (this.closed) throw new Error("database bridge is closed");
    Atomics.store(this.flag, 0, 0);
    this.worker.postMessage({ method, args });
    const r = Atomics.wait(this.flag, 0, 0, timeoutMs);
    if (r === "timed-out") throw new Error(`database call timed out after ${timeoutMs}ms: ${method}`);
    const msg = receiveMessageOnPort(this.port) as { message?: { result?: T; error?: string } } | undefined;
    if (!msg?.message) throw new Error("database worker returned no message");
    if (msg.message.error !== undefined) throw new Error(msg.message.error);
    return msg.message.result as T;
  }

  close(): void {
    if (this.closed) return;
    try { this.call("__close", [], 10_000); } catch { /* ignore */ }
    this.closed = true;
    void this.worker.terminate();
  }
}
