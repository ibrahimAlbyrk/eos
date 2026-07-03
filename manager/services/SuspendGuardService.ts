import type { Clock } from "../../core/src/ports/Clock.ts";

// Per-worker "intentional suspend in flight" window. suspendWorker marks a worker
// BEFORE it stops the live session; stopping a CLI child (or an in-process backend)
// races an async process exit → onExit → markDone(DONE), which would clobber the
// SUSPENDED state we set. While a worker is marked, the spawn/resume onExit skips
// markDone so SUSPENDED holds on both lanes. A generous TTL (mirroring
// TurnSettleService) auto-clears the flag so a genuine later exit — e.g. after the
// worker is resumed — still marks DONE normally.
export class SuspendGuardService {
  private suspendUntil = new Map<string, number>();
  private clock: Clock;
  private windowMs: number;
  constructor(clock: Clock, windowMs: number = 30_000) {
    this.clock = clock;
    this.windowMs = windowMs;
  }

  mark(workerId: string): void {
    this.suspendUntil.set(workerId, this.clock.now() + this.windowMs);
  }
  clear(workerId: string): void {
    this.suspendUntil.delete(workerId);
  }
  isSuspending(workerId: string): boolean {
    const until = this.suspendUntil.get(workerId);
    if (!until) return false;
    if (this.clock.now() > until) { this.suspendUntil.delete(workerId); return false; }
    return true;
  }
}
