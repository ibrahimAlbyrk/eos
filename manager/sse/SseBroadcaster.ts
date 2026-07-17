// SSE broadcaster — subscribes to the in-process event bus and pushes a
// `change` event to every connected client. Keepalive pings on the daemon's
// configured cadence keep connections warm through proxies that close idle
// HTTP streams.

import type { ServerResponse } from "node:http";
import type { EventBus } from "../../core/src/ports/EventBus.ts";
import { sanitizeForDisplay } from "../shared/display-sanitize.ts";

export interface SseBroadcasterOptions {
  bus: EventBus;
  keepaliveMs: number;
}

// Per-client backpressure state. Once res.write() reports a full socket buffer
// (`saturated`), further events are dropped rather than queued — SSE replays
// nothing on reconnect and dropped change/delta events are healed by the UI's
// polling + durable rows, so lossy is safe. `dropped` counts events skipped
// while stuck; past MAX_DROPPED_EVENTS the client is end()ed so EventSource
// reconnects with a fresh buffer instead of a permanently zombie socket.
interface ClientState {
  saturated: boolean;
  dropped: number;
  onDrain: () => void;
}

export class SseBroadcaster {
  // A stuck client buffers nothing further once saturated (we drop), so memory
  // is already bounded; this cap just recycles a client that never drains.
  private static readonly MAX_DROPPED_EVENTS = 500;

  private readonly clients = new Map<ServerResponse, ClientState>();
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
    const state: ClientState = {
      saturated: false,
      dropped: 0,
      onDrain: (): void => { state.saturated = false; state.dropped = 0; },
    };
    res.on("drain", state.onDrain);
    this.clients.set(res, state);
    const ka = setInterval(() => {
      try { res.write(":ka\n\n"); } catch {
        clearInterval(ka);
        this.removeClient(res);
      }
    }, this.opts.keepaliveMs);
    return {
      detach: (): void => {
        clearInterval(ka);
        this.removeClient(res);
      },
    };
  }

  broadcast(reason: string, payload?: unknown): void {
    if (this.clients.size === 0) return;
    // Sanitize a display copy — live text payloads (agent:delta, model echoes)
    // must never stream a sender-tag wrapper to a connected client.
    const msg = `event: change\ndata: ${JSON.stringify({ reason, ts: Date.now(), payload: sanitizeForDisplay(payload) })}\n\n`;
    for (const [res, state] of this.clients) {
      if (state.saturated) {
        if (++state.dropped >= SseBroadcaster.MAX_DROPPED_EVENTS) this.endSaturatedClient(res);
        continue;
      }
      // write() returning false means the socket buffer is full: stop writing to
      // this client until its 'drain' fires (state.onDrain clears saturated).
      try { if (!res.write(msg)) state.saturated = true; } catch { this.removeClient(res); }
    }
  }

  private removeClient(res: ServerResponse): void {
    const state = this.clients.get(res);
    if (state) res.off("drain", state.onDrain);
    this.clients.delete(res);
  }

  private endSaturatedClient(res: ServerResponse): void {
    this.removeClient(res);
    try { res.end(); } catch { /* already torn down */ }
  }

  size(): number { return this.clients.size; }
}
