// SSE broadcaster — subscribes to the in-process event bus and pushes a
// `change` event to every connected client. Keepalive pings on the daemon's
// configured cadence keep connections warm through proxies that close idle
// HTTP streams.
//
// Resumable: every event carries `id: <epoch>-<seq>` and the recent ones stay
// in a bounded ring. A client that reconnects with `since` (its last id) gets
// exactly what it missed replayed before live events; when the ring no longer
// covers the gap — or the daemon restarted (new epoch) — it gets one `resync`
// event instead and refetches its state. This is what lets a controlling
// computer ride out a dropped link without losing a single terminal byte.

import { randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { EventBus } from "../../core/src/ports/EventBus.ts";
import { sanitizeForDisplay } from "../shared/display-sanitize.ts";

export interface SseBroadcasterOptions {
  bus: EventBus;
  keepaliveMs: number;
  ringMaxEvents?: number;
  ringMaxBytes?: number;
}

export interface SseAttachOptions {
  // The last event id the client received ("<epoch>-<seq>").
  since?: string | null;
  // Only these topics ("worker:change") or families ("worker:*"). Absent ⇒ all.
  topics?: readonly string[] | null;
}

// Per-client backpressure state. Once res.write() reports a full socket buffer
// (`saturated`), further events are skipped rather than queued. A client that
// missed anything is closed on drain instead of resumed with a hole: it
// reconnects with its last id and the ring replays the skipped events. Past
// MAX_DROPPED_EVENTS a client that never drains is recycled the same way.
interface ClientState {
  saturated: boolean;
  dropped: number;
  wants: (reason: string) => boolean;
  onDrain: () => void;
}

interface RingEntry {
  seq: number;
  reason: string;
  frame: string;
}

function topicFilter(topics: readonly string[] | null | undefined): (reason: string) => boolean {
  if (!topics || topics.length === 0) return () => true;
  const exact = new Set(topics.filter((t) => !t.endsWith(":*")));
  const families = topics.filter((t) => t.endsWith(":*")).map((t) => t.slice(0, -1));
  return (reason) => exact.has(reason) || families.some((f) => reason.startsWith(f));
}

export class SseBroadcaster {
  private static readonly MAX_DROPPED_EVENTS = 500;

  private readonly clients = new Map<ServerResponse, ClientState>();
  private readonly opts: SseBroadcasterOptions;
  private readonly epoch = randomBytes(6).toString("hex");
  private seq = 0;
  private readonly ring: RingEntry[] = [];
  private ringBytes = 0;
  private readonly ringMaxEvents: number;
  private readonly ringMaxBytes: number;

  constructor(opts: SseBroadcasterOptions) {
    this.opts = opts;
    this.ringMaxEvents = opts.ringMaxEvents ?? 5000;
    this.ringMaxBytes = opts.ringMaxBytes ?? 8 * 1024 * 1024;
    this.opts.bus.subscribe("*", (msg) => {
      this.broadcast(`${msg.topic}`, msg.payload);
    });
  }

  currentId(): string {
    return `${this.epoch}-${this.seq}`;
  }

  attach(res: ServerResponse, opts: SseAttachOptions = {}): { detach(): void } {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 2000\n\n");
    res.write(":connected\n\n");
    const wants = topicFilter(opts.topics);
    const state: ClientState = {
      saturated: false,
      dropped: 0,
      wants,
      onDrain: (): void => {
        if (state.dropped > 0) { this.endClient(res); return; }
        state.saturated = false;
      },
    };
    // Replay (or resync) before registering for live events: both run
    // synchronously, so no live event can slip in between.
    if (opts.since) this.catchUp(res, opts.since, wants);
    else res.write(this.helloFrame());
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
    const seq = ++this.seq;
    // Sanitize a display copy — live text payloads (agent:delta, model echoes)
    // must never stream a sender-tag wrapper to a connected client.
    const frame = `id: ${this.epoch}-${seq}\nevent: change\ndata: ${JSON.stringify({ reason, ts: Date.now(), payload: sanitizeForDisplay(payload) })}\n\n`;
    this.remember({ seq, reason, frame });
    for (const [res, state] of this.clients) {
      if (!state.wants(reason)) continue;
      if (state.saturated) {
        if (++state.dropped >= SseBroadcaster.MAX_DROPPED_EVENTS) this.endClient(res);
        continue;
      }
      // write() returning false means the socket buffer is full: stop writing to
      // this client until its 'drain' fires.
      try { if (!res.write(frame)) state.saturated = true; } catch { this.removeClient(res); }
    }
  }

  private helloFrame(): string {
    return `id: ${this.currentId()}\nevent: hello\ndata: ${JSON.stringify({ epoch: this.epoch, seq: this.seq })}\n\n`;
  }

  private catchUp(res: ServerResponse, since: string, wants: (reason: string) => boolean): void {
    const m = /^([0-9a-f]+)-(\d+)$/.exec(since);
    const lastSeq = m ? Number(m[2]) : NaN;
    const oldest = this.ring.length ? this.ring[0].seq : this.seq + 1;
    const replayable = m != null && m[1] === this.epoch && lastSeq <= this.seq && lastSeq >= oldest - 1;
    if (!replayable) {
      res.write(`id: ${this.currentId()}\nevent: resync\ndata: ${JSON.stringify({ epoch: this.epoch, seq: this.seq })}\n\n`);
      return;
    }
    for (const e of this.ring) {
      if (e.seq > lastSeq && wants(e.reason)) res.write(e.frame);
    }
  }

  private remember(entry: RingEntry): void {
    this.ring.push(entry);
    this.ringBytes += entry.frame.length;
    while (this.ring.length > this.ringMaxEvents || (this.ringBytes > this.ringMaxBytes && this.ring.length > 1)) {
      this.ringBytes -= this.ring.shift()!.frame.length;
    }
  }

  private removeClient(res: ServerResponse): void {
    const state = this.clients.get(res);
    if (state) res.off("drain", state.onDrain);
    this.clients.delete(res);
  }

  private endClient(res: ServerResponse): void {
    this.removeClient(res);
    try { res.end(); } catch { /* already torn down */ }
  }

  size(): number { return this.clients.size; }
}
