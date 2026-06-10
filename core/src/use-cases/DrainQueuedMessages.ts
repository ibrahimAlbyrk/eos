// DrainQueuedMessages — delivers a worker's queued dashboard messages when it
// reaches IDLE. The daemon (not the web) owns both the queue and the IDLE
// signal, so the flush decision is made against authoritative state — the
// web's old render-effect flush (stale busy snapshots, refs surviving agent
// switches) is gone entirely.
//
// Rows are marked dispatched only AFTER a successful dispatch: a failed drain
// leaves them pending and the next IDLE retries. The rare opposite (crash
// between dispatch and mark) re-sends rather than silently losing a message.

import type { WorkerRepo } from "../ports/WorkerRepo.ts";
import type { MessageQueueRepo } from "../ports/MessageQueueRepo.ts";
import type { Clock } from "../ports/Clock.ts";
import type { Logger } from "../ports/Logger.ts";
import type { DispatchMessageInput } from "./DispatchMessage.ts";

export interface DrainQueuedMessagesDeps {
  workers: WorkerRepo;
  queue: MessageQueueRepo;
  clock: Clock;
  log: Logger;
  /** TurnSettleService.clear — the drain starts a genuine new turn; without
   *  this the settle window suppresses its WORKING transition. Called only
   *  when there is actually something to dispatch. */
  clearTurnSettle(workerId: string): void;
  /** dispatchMessage bound to the daemon's full dependency set — keeps this
   *  use-case decoupled from the dispatch internals. */
  dispatch(input: DispatchMessageInput): Promise<{ status: number; body: unknown }>;
}

export type DrainOutcome = "dispatched" | "empty" | "not-idle" | "failed";

export async function drainQueuedMessages(
  deps: DrainQueuedMessagesDeps,
  input: { workerId: string },
): Promise<DrainOutcome> {
  const w = deps.workers.findById(input.workerId);
  if (!w) return "empty";
  // IDLE only: WORKING/SPAWNING wait for the next transition; EXITED/SUSPENDED
  // must not get a ghost dispatch (their rows wait for a future IDLE).
  if (String(w.state).toUpperCase() !== "IDLE") return "not-idle";

  const rows = deps.queue.listPending(input.workerId);
  if (rows.length === 0) return "empty";

  // One combined delivery, matching the old web flush UX (and one turn, not N).
  const combined = rows.map((r) => r.text).join("\n\n");
  const clientMsgIds = rows.map((r) => r.clientMsgId).filter((x): x is string => x !== null);

  deps.clearTurnSettle(input.workerId);
  try {
    await deps.dispatch({
      workerId: input.workerId,
      text: combined,
      recordClientMsgIds: clientMsgIds,
      origin: "queue-drain",
    });
  } catch (e) {
    deps.log.warn("queue drain dispatch failed — rows stay pending", {
      workerId: input.workerId,
      error: e instanceof Error ? e.message : String(e),
    });
    return "failed";
  }
  deps.queue.markDispatched(rows.map((r) => r.id), deps.clock.now());
  deps.log.info("queue drained", { workerId: input.workerId, count: rows.length });
  return "dispatched";
}
