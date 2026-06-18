// DrainQueuedMessages — delivers a worker's queued dashboard messages when it
// reaches IDLE. The daemon (not the web) owns both the queue and the IDLE
// signal, so the flush decision is made against authoritative state — the
// web's old render-effect flush (stale busy snapshots, refs surviving agent
// switches) is gone entirely.
//
// FIFO, one message per turn: each IDLE dispatches only the OLDEST pending
// row, so the agent answers a, stops, gets b, stops, gets c — a deep backlog
// never collapses into one mega-prompt. No scheduler is needed for the rest:
// the dispatched turn's own Stop → IDLE transition is the next trigger (and
// a delivery_failed heal reaches IDLE the same way, so the chain survives a
// lost message).
//
// The row is marked dispatched only AFTER a successful dispatch: a failed
// drain leaves it pending and the next IDLE retries. The rare opposite (crash
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

  // listPending is id-ASC — rows[0] is the oldest message (FIFO head).
  const head = rows[0];

  deps.clearTurnSettle(input.workerId);
  try {
    await deps.dispatch({
      workerId: input.workerId,
      text: head.text,
      recordClientMsgIds: head.clientMsgId !== null ? [head.clientMsgId] : [],
      origin: "queue-drain",
      // Replay the original kind so a queued report drains as a worker_report,
      // not a plain user_message. Absent for plain dashboard sends.
      ...(head.envelope ? { envelope: head.envelope } : {}),
      ...(head.displayText != null ? { displayText: head.displayText } : {}),
    });
  } catch (e) {
    deps.log.warn("queue drain dispatch failed — row stays pending", {
      workerId: input.workerId,
      queueId: head.id,
      error: e instanceof Error ? e.message : String(e),
    });
    return "failed";
  }
  deps.queue.markDispatched([head.id], deps.clock.now());
  deps.log.info("queue drained one", {
    workerId: input.workerId,
    queueId: head.id,
    remaining: rows.length - 1,
  });
  return "dispatched";
}
