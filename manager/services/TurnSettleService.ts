import type { Clock } from "../../core/src/ports/Clock.ts";

// Per-worker "turn just ended" settle window. When a turn ends (Stop hook) or is
// interrupted, trailing transcript events for that finished turn can still arrive
// at the daemon out of order (hook and jsonl ride independent fire-and-forget
// channels — see spawner/events.ts). During the settle window those stragglers
// must not re-animate a correctly-idle worker back to WORKING. A genuine new turn
// arrives via a deliberate route transition (user/orchestrator message, worker
// report) which calls clear() first, or as the agent stream's own turn start,
// which the window doesn't hold — so it can never starve a real turn.
export class TurnSettleService {
  private settleUntil = new Map<string, number>();
  // Interrupted, but the agent's stream hasn't ended that turn yet (mark() does).
  private interrupted = new Set<string>();
  private clock: Clock;
  private settleMs: number;
  constructor(clock: Clock, settleMs: number = 4000) {
    this.clock = clock;
    this.settleMs = settleMs;
  }

  mark(workerId: string): void {
    this.settleUntil.set(workerId, this.clock.now() + this.settleMs);
    this.interrupted.delete(workerId);
  }
  markInterrupt(workerId: string): void {
    this.mark(workerId);
    this.interrupted.add(workerId);
  }
  clear(workerId: string): void {
    this.settleUntil.delete(workerId);
    this.interrupted.delete(workerId);
  }
  isSettling(workerId: string): boolean {
    const until = this.settleUntil.get(workerId);
    if (!until) return false;
    if (this.clock.now() > until) { this.clear(workerId); return false; }
    return true;
  }
  isInterruptPending(workerId: string): boolean {
    return this.isSettling(workerId) && this.interrupted.has(workerId);
  }
}
