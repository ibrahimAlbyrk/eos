// suspendWorker — pause a live worker WITHOUT tearing down its worktree. Unlike
// the kill/purge cascade (which deletes the row and reaps the worktree), suspend
// stops only the session and moves the row to SUSPENDED, leaving the branch and
// worktree intact for integration or a later resume. Triggered by the
// context-full watcher (R4); never a user-facing route.
//
// The four steps in order:
//   1. mark the intentional-suspend flag BEFORE stopping, so the CLI lane's
//      onExit → markDone race can't clobber SUSPENDED back to DONE.
//   2. stop the live session (CLI PTY escalate / in-process backend stop).
//   3. transition the row to SUSPENDED (WORKING→ and IDLE→ are both legal).
//   4. clear pid/port runtime (the row is now at rest until resumed).
// It NEVER calls cascadeWorkerRemoval / any worktree code — that is the whole point.

import type { Container } from "../../container.ts";
import { stopWorkerSession } from "../../routes/resume-helpers.ts";
import { transitionState } from "../../../core/src/use-cases/TransitionState.ts";

export function suspendWorker(c: Container, id: string, reason: string): void {
  const worker = c.workers.findById(id);
  if (!worker) return;
  c.suspendGuard.mark(id);
  stopWorkerSession(c, id);
  transitionState(
    { workers: c.workers, events: c.events, bus: c.bus, clock: c.clock },
    { workerId: id, next: "SUSPENDED", reason },
  );
  c.workers.clearRuntime(id);
}
