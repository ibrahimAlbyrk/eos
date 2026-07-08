// SchedulerService — a periodic tick that fires due scheduled prompts. Mirrors
// UpdateService: constructor deps incl. clock, explicit start(intervalMs),
// setInterval that is .unref'd so it never holds the process open. The actual
// firing is the pure FireScheduledPrompts use-case; this service just owns the
// timer and the overlap guard (a slow tick must not let the next interval run a
// second concurrent pass over the same due rows).

import type { Clock } from "../../core/src/ports/Clock.ts";
import type { Logger } from "../../core/src/ports/Logger.ts";
import type { ScheduledPromptRepo, ScheduledPromptRow } from "../../core/src/ports/ScheduledPromptRepo.ts";
import { fireScheduledPrompts, type ScheduledDispatchInput } from "../../core/src/use-cases/FireScheduledPrompts.ts";

export interface SchedulerServiceOpts {
  repo: ScheduledPromptRepo;
  clock: Clock;
  dispatch(input: ScheduledDispatchInput): Promise<{ status: number; body: unknown }>;
  onFired?(row: ScheduledPromptRow): void;
  log: Logger;
}

export class SchedulerService {
  private readonly o: SchedulerServiceOpts;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(o: SchedulerServiceOpts) {
    this.o = o;
  }

  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await fireScheduledPrompts({
        repo: this.o.repo,
        clock: this.o.clock,
        dispatch: this.o.dispatch,
        onFired: this.o.onFired,
        log: this.o.log,
      });
    } catch (e) {
      this.o.log.warn("scheduler tick failed", { error: e instanceof Error ? e.message : String(e) });
    } finally {
      this.ticking = false;
    }
  }
}
