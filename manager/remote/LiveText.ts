// LiveText — the remote edge's memory of in-flight streaming text. `agent:delta`
// frames are increments with no offset, so a device that missed some
// (backgrounded, reconnecting) would render a hole. This keeps each streaming
// block's text so far; the resume snapshot hands it over and the device re-seeds
// its live buffer from it.

import type { EventBus } from "../../core/src/ports/EventBus.ts";
import type { LiveBlock } from "../../contracts/src/remote.ts";

// A stopped block stays a while: its durable row lands only when the whole
// message ends, and a device resuming in between still needs the text. Past the
// TTL the row has landed, and an idle worker's blocks would only bloat every
// resume snapshot.
const MAX_BLOCKS_PER_WORKER = 6;
export const STOPPED_BLOCK_TTL_MS = 120_000;

type TrackedBlock = LiveBlock & { stoppedAt?: number };

type DeltaPayload = { workerId?: unknown; channel?: unknown; phase?: unknown; blockId?: unknown; text?: unknown };

export class LiveText {
  private readonly bus: EventBus;
  private readonly now: () => number;
  private readonly byWorker = new Map<string, TrackedBlock[]>();
  private unsubs: Array<() => void> = [];

  constructor(bus: EventBus, now: () => number) { this.bus = bus; this.now = now; }

  start(): void {
    if (this.unsubs.length > 0) return;
    this.unsubs.push(this.bus.subscribe("agent:delta", (msg) => this.onDelta(msg.payload as DeltaPayload)));
    for (const topic of ["worker:exit", "worker:removed"] as const) {
      this.unsubs.push(this.bus.subscribe(topic, (msg) => {
        const id = (msg.payload as { workerId?: unknown } | null)?.workerId;
        if (typeof id === "string") this.byWorker.delete(id);
      }));
    }
  }

  stop(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.byWorker.clear();
  }

  snapshot(): LiveBlock[] {
    const cutoff = this.now() - STOPPED_BLOCK_TTL_MS;
    const out: LiveBlock[] = [];
    for (const [workerId, blocks] of this.byWorker) {
      const kept = blocks.filter((b) => b.stoppedAt === undefined || b.stoppedAt > cutoff);
      if (kept.length === 0) this.byWorker.delete(workerId);
      else this.byWorker.set(workerId, kept);
      for (const { stoppedAt: _, ...b } of kept) out.push(b);
    }
    return out;
  }

  private onDelta(p: DeltaPayload): void {
    if (typeof p.workerId !== "string" || typeof p.blockId !== "string") return;
    const text = typeof p.text === "string" ? p.text : "";
    const blocks = this.byWorker.get(p.workerId) ?? [];
    const channel = p.channel === "text" ? "text" : "reasoning";
    const existing = blocks.find((b) => b.blockId === p.blockId);
    if (existing) {
      if (p.phase === "start") Object.assign(existing, { channel, text, stoppedAt: undefined });
      else if (p.phase === "append") existing.text += text;
      else if (p.phase === "stop") existing.stoppedAt = this.now();
      return;
    }
    if (p.phase === "stop") return;
    // An append with no start seen (armed mid-stream) still seeds a block: partial beats nothing.
    blocks.push({ workerId: p.workerId, blockId: p.blockId, channel, text });
    if (blocks.length > MAX_BLOCKS_PER_WORKER) blocks.shift();
    this.byWorker.set(p.workerId, blocks);
  }
}
