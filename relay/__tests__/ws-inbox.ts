import type { WebSocket } from "ws";
import { parseEnvelope } from "../envelope.ts";

// Buffers inbound binary messages so a test can await them in arrival order.
export class Inbox {
  private queue: Buffer[] = [];
  private waiters: ((b: Buffer) => void)[] = [];
  constructor(ws: WebSocket) {
    ws.binaryType = "nodebuffer";
    ws.on("message", (d) => {
      const buf = d as Buffer;
      const w = this.waiters.shift();
      if (w) w(buf);
      else this.queue.push(buf);
    });
  }
  next(): Promise<Buffer> {
    const q = this.queue.shift();
    if (q) return Promise.resolve(q);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

export function body(buf: Buffer): Record<string, unknown> {
  return JSON.parse(parseEnvelope(buf).payload.toString("utf8"));
}
