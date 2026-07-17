// suspendWorker — pause a live worker WITHOUT tearing down its worktree. Unlike
// the kill/purge cascade (which deletes the row and reaps the worktree), suspend
// stops only the session and moves the row to SUSPENDED, leaving the branch and
// worktree intact for integration or a later resume. Triggered by the
// context-full watcher (R4) and the daemon-shutdown sweep below; never a
// user-facing route.
//
// The four steps in order:
//   1. mark the intentional-suspend flag BEFORE stopping, so the exit callback's
//      markDone race can't clobber SUSPENDED back to DONE.
//   2. transition the row to SUSPENDED (WORKING→ and IDLE→ are both legal) —
//      BEFORE the stop: a metered in-process stop() emits `session ended`
//      synchronously, and the ENDING that would set is a state SUSPENDED cannot
//      be reached from. Set SUSPENDED first and the late ENDING is rejected by
//      the FSM instead.
//   3. stop the live session (CLI PTY escalate / in-process backend stop).
//   4. clear pid/port runtime (the row is now at rest until resumed).
// It NEVER calls cascadeWorkerRemoval / any worktree code — that is the whole point.

import type { Container } from "../../container.ts";
import { stopWorkerSession } from "../../routes/resume-helpers.ts";
import { transitionState } from "../../../core/src/use-cases/TransitionState.ts";

export function suspendWorker(c: Container, id: string, reason: string): void {
  const worker = c.workers.findById(id);
  if (!worker) return;
  c.suspendGuard.mark(id);
  transitionState(
    { workers: c.workers, events: c.events, bus: c.bus, clock: c.clock },
    { workerId: id, next: "SUSPENDED", reason },
  );
  stopWorkerSession(c, id);
  c.workers.clearRuntime(id);
}

// Daemon-shutdown sweep: suspend every active worker whose session survives the
// restart (in-process backend + resumable capability + persisted session_id), so
// `eos restart`/build deterministically leaves them SUSPENDED and resumable —
// instead of racing their async exit callbacks against db.close ("statement has
// been finalized" noise) and leaving boot reconcile to guess from stale rows.
// PTY-lane workers and rows without a session keep the old path: die with the
// daemon, ReconcileWorkersOnBoot settles them (it also stays the crash/-9 net).
export function suspendResumableWorkersForShutdown(c: Container): number {
  let suspended = 0;
  for (const row of c.workers.listAll()) {
    if (row.state !== "SPAWNING" && row.state !== "WORKING" && row.state !== "IDLE") continue;
    if (!row.session_id) continue;
    const kind = row.backend_kind;
    if (!kind || !c.backends.has(kind)) continue;
    const d = c.backends.get(kind).descriptor;
    if (d.processModel !== "in-process" || d.capabilities.resumable !== true) continue;
    try {
      suspendWorker(c, row.id, "daemon_shutdown");
      suspended++;
    } catch (e) {
      c.log.warn("shutdown suspend failed", { workerId: row.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return suspended;
}
