// SSE broadcaster — subscribes to the in-process event bus and pushes a
// `change` event to every connected client. Keepalive pings on the daemon's
// configured cadence keep connections warm through proxies that close idle
// HTTP streams.

import type { ServerResponse } from "node:http";
import type { EventBus } from "../../core/src/ports/EventBus.ts";

export interface SseBroadcasterOptions {
  bus: EventBus;
  keepaliveMs: number;
}

export class SseBroadcaster {
  private readonly clients = new Set<ServerResponse>();
  private readonly opts: SseBroadcasterOptions;

  constructor(opts: SseBroadcasterOptions) {
    this.opts = opts;
    this.opts.bus.subscribe("*", (msg) => {
      this.broadcast(`${msg.topic}`, msg.payload);
    });
  }

  attach(res: ServerResponse): { detach(): void } {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 2000\n\n");
    res.write(":connected\n\n");
    this.clients.add(res);
    const ka = setInterval(() => {
      try { res.write(":ka\n\n"); } catch {
        clearInterval(ka);
        this.clients.delete(res);
      }
    }, this.opts.keepaliveMs);
    return {
      detach: (): void => {
        clearInterval(ka);
        this.clients.delete(res);
      },
    };
  }

  broadcast(reason: string, payload?: unknown): void {
    if (this.clients.size === 0) return;
    const msg = `event: change\ndata: ${JSON.stringify({ reason, ts: Date.now(), payload })}\n\n`;
    for (const res of this.clients) {
      try { res.write(msg); } catch { this.clients.delete(res); }
    }
  }

  size(): number { return this.clients.size; }
}
