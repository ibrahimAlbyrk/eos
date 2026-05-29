import type { Clock } from "../../core/src/ports/Clock.ts";

// Per-worker "turn just ended" settle window. When a turn ends (Stop hook) or is
// interrupted, trailing transcript events for that finished turn can still arrive
// at the daemon out of order (hook and jsonl ride independent fire-and-forget
// channels — see spawner/events.ts). During the settle window those stragglers
// must not re-animate a correctly-idle worker back to WORKING. A genuine new turn
// always arrives via a deliberate route transition (user/orchestrator message,
// worker report) which calls clear() first, so the window can never starve a real
// turn.
export class TurnSettleService {
  private settleUntil = new Map<string, number>();
  private clock: Clock;
  private settleMs: number;
  constructor(clock: Clock, settleMs: number = 4000) {
    this.clock = clock;
    this.settleMs = settleMs;
  }

  mark(workerId: string): void {
    this.settleUntil.set(workerId, this.clock.now() + this.settleMs);
  }
  clear(workerId: string): void {
    this.settleUntil.delete(workerId);
  }
  isSettling(workerId: string): boolean {
    const until = this.settleUntil.get(workerId);
    if (!until) return false;
    if (this.clock.now() > until) { this.settleUntil.delete(workerId); return false; }
    return true;
  }
}
