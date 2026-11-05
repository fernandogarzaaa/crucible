import { EventEmitter } from "node:events";

/** In-process pub/sub used by SSE endpoints (run events, eval progress, approvals). */
export class Bus {
  private em = new EventEmitter();
  constructor() { this.em.setMaxListeners(1000); }
  publish(topic: string, data: unknown) { this.em.emit(topic, data); }
  subscribe(topic: string, fn: (data: unknown) => void): () => void {
    this.em.on(topic, fn);
    return () => this.em.off(topic, fn);
  }
}
