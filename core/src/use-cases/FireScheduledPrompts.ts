// FireScheduledPrompts — one pass over the due pending rows. For each: dispatch
// the prompt FIRST, then mark it fired only if the dispatch didn't throw. A
// throw (worker unreachable/dead) leaves the row pending so the next tick
// retries; the caller's dispatch carries a stable clientMsgId ("sched-<id>"),
// so a retry after a crash between dispatch and markFired dedups instead of
// double-delivering. A prompt fired well after its fireAt is tagged meta.late.

import type { ScheduledPromptRepo, ScheduledPromptRow } from "../ports/ScheduledPromptRepo.ts";
import type { Clock } from "../ports/Clock.ts";
import type { Logger } from "../ports/Logger.ts";

const LATE_THRESHOLD_MS = 60_000;

export interface ScheduledDispatchInput {
  workerId: string;
  text: string;
  clientMsgId: string;
  origin: string;
  queueWhenBusy: boolean;
}

export interface FireScheduledPromptsDeps {
  repo: ScheduledPromptRepo;
  clock: Clock;
  dispatch(input: ScheduledDispatchInput): Promise<{ status: number; body: unknown }>;
  /** Emit the scheduled_prompt:fired timeline event (wired to appendSynthesized). */
  onFired?(row: ScheduledPromptRow): void;
  log?: Logger;
}

export async function fireScheduledPrompts(deps: FireScheduledPromptsDeps): Promise<number> {
  const now = deps.clock.now();
  const due = deps.repo.listDue(now);
  let fired = 0;
  for (const row of due) {
    try {
      await deps.dispatch({
        workerId: row.workerId,
        text: row.text,
        clientMsgId: `sched-${row.id}`,
        origin: "scheduled",
        queueWhenBusy: true,
      });
    } catch (e) {
      deps.log?.warn("scheduled prompt dispatch failed — leaving pending for retry", {
        id: row.id,
        workerId: row.workerId,
        error: e instanceof Error ? e.message : String(e),
      });
      continue;
    }
    const firedAt = deps.clock.now();
    const meta = now - row.fireAt > LATE_THRESHOLD_MS
      ? { ...(row.meta ?? {}), late: true }
      : row.meta;
    deps.repo.markFired(row.id, firedAt, meta);
    deps.onFired?.({ ...row, status: "fired", firedAt, meta });
    fired++;
  }
  return fired;
}
