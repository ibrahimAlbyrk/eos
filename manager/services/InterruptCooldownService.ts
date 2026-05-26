import type { Clock } from "../../core/src/ports/Clock.ts";

export class InterruptCooldownService {
  private cooldowns = new Map<string, number>();
  private clock: Clock;
  private cooldownMs: number;
  constructor(clock: Clock, cooldownMs: number = 4000) {
    this.clock = clock;
    this.cooldownMs = cooldownMs;
  }

  mark(workerId: string): void {
    this.cooldowns.set(workerId, this.clock.now() + this.cooldownMs);
  }
  clear(workerId: string): void {
    this.cooldowns.delete(workerId);
  }
  isActive(workerId: string): boolean {
    const until = this.cooldowns.get(workerId);
    if (!until) return false;
    if (this.clock.now() > until) { this.cooldowns.delete(workerId); return false; }
    return true;
  }
}
