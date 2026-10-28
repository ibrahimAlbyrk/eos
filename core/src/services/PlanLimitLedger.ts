// PlanLimitLedger — which plan sign-ins can't run right now, kept in memory. A
// plan limit lifts by itself at its reset time; a sign-in that stopped working
// stays out until it is signed in again (clear()). New sessions and account
// switches skip whatever is listed here.

import type { Clock } from "../ports/Clock.ts";

export type PlanLimitReason = "limit" | "expired";

// ready: can run. limited: at its plan limit, still signed in. out: can't run
// until it is signed in again.
export type LoginReadiness = "ready" | "limited" | "out";

export interface PlanLimitMark {
  readonly reason: PlanLimitReason;
  // When a limit lifts (epoch ms); absent for a sign-in that stopped working.
  readonly until?: number;
}

// A limit reported without its reset time is retried after this long.
const LIMIT_WITHOUT_RESET_MS = 60 * 60_000;

export class PlanLimitLedger {
  private readonly clock: Clock;
  private readonly marks = new Map<string, PlanLimitMark>();

  constructor(clock: Clock) {
    this.clock = clock;
  }

  mark(loginId: string, reason: PlanLimitReason, until?: number): void {
    this.marks.set(loginId, reason === "limit" ? { reason, until: until ?? this.clock.now() + LIMIT_WITHOUT_RESET_MS } : { reason });
  }

  clear(loginId: string): void {
    this.marks.delete(loginId);
  }

  readiness(loginId: string, signedIn: boolean): LoginReadiness {
    const mark = this.blocked(loginId);
    if (!signedIn || mark?.reason === "expired") return "out";
    return mark ? "limited" : "ready";
  }

  blocked(loginId: string): PlanLimitMark | null {
    const mark = this.marks.get(loginId);
    if (!mark) return null;
    if (mark.until !== undefined && mark.until <= this.clock.now()) {
      this.marks.delete(loginId);
      return null;
    }
    return mark;
  }
}
