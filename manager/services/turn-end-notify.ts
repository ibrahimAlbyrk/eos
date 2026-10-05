// Turn-end notification. When a top-level agent (one the operator talks to
// directly) finishes its turn, publish `notification:fire` titled with its name
// and carrying the start of its last reply — the desktop app turns it into a
// macOS banner while it is in the background. Sub-workers are skipped: they
// report to their parent, and a banner per worker would be noise. A turn that
// ends with background subagents still running is skipped too: each report
// wakes the agent again, so only the turn after the last one is the real end.

import type { WorkerRow } from "../../contracts/src/worker.ts";
import type { WorkerEventRow } from "../../contracts/src/events.ts";
import { normalizeEventRows } from "../../core/src/domain/message-normalize.ts";
import { truncate } from "./permission-ask-push.ts";
import type { NotificationFire } from "./permission-ask-notify.ts";

export interface TurnEndNotifyDeps {
  findWorker(id: string): WorkerRow | null;
  // Event rows newer than `since`, oldest→newest.
  eventsSince(workerId: string, since: number): WorkerEventRow[];
  liveSubagents(workerId: string): number;
  fire(notification: NotificationFire): void;
  now(): number;
  // Runs the check a beat after the IDLE edge: a queued message, a loop tick or
  // compaction lifts the worker straight back to WORKING (no banner then), and
  // the CLI lane's transcript rows can land just after its Stop hook.
  defer(fn: () => void): void;
}

// The bus handler for "worker:change" ({ workerId, from, state }). Only a
// WORKING→IDLE edge counts; a turn with no assistant text (compaction, a failed
// delivery) is a silent skip.
export function makeTurnEndNotify(
  deps: TurnEndNotifyDeps,
): (payload: { workerId?: string; from?: string; state?: string }) => void {
  return (payload) => {
    if (!payload?.workerId || payload.from !== "WORKING" || payload.state !== "IDLE") return;
    const workerId = payload.workerId;
    deps.defer(() => {
      const w = deps.findWorker(workerId);
      if (!w || w.parent_id || w.state !== "IDLE" || !w.turn_started_at) return;
      if (deps.liveSubagents(workerId) > 0) return;
      const reply = normalizeEventRows(deps.eventsSince(workerId, w.turn_started_at - 1), Infinity)
        .filter((m) => m.role === "assistant")
        .at(-1);
      if (!reply) return;
      deps.fire({
        title: w.name ?? workerId,
        body: truncate(reply.text.replace(/\s+/g, " ").trim(), 160),
        workerId,
        ts: deps.now(),
      });
    });
  };
}
