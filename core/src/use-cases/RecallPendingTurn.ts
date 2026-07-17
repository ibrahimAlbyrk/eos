// RecallPendingTurn — the DECISION behind "interrupt before the agent responded
// → recall the just-sent message". Pure: it reads the turn-output signal, finds
// the bubble to recall, drops the dispatch ledger row, and returns what the
// daemon must hide + restore. The side effects (emit the message_recalled
// marker, roll back the SDK context, restore the composer) live in the outer
// layers — the handler owns them.
//
// Two outcomes:
//   - output already seen this turn, or the turn has no recall target (an
//     agent-plane dispatch, or nothing dispatched) → { recalled: false } (the
//     handler does a normal interrupt, no recall).
//   - output empty AND a recall target known → { recalled: true, ... } carrying
//     THAT user_message row's text + clientMsgId + id, ledger row dropped.
//
// SDK-lane only: the daemon owns the user_message row there (!reportsMessageEvents).
// The handler gates the call on that capability; this use-case stays lane-blind.

import type { EventRepo } from "../ports/EventRepo.ts";
import type { MessageQueueRepo } from "../ports/MessageQueueRepo.ts";
import type { TurnOutputTracker } from "../ports/TurnOutputTracker.ts";

export interface RecallPendingTurnDeps {
  events: EventRepo;
  queue: MessageQueueRepo;
  turnOutput: TurnOutputTracker;
}

export type RecallPendingTurnResult =
  | { recalled: false }
  | { recalled: true; text: string; clientMsgId?: string; rowId: number };

export function recallPendingTurn(
  deps: RecallPendingTurnDeps,
  workerId: string,
): RecallPendingTurnResult {
  // The agent already produced output this turn (first delta on either channel,
  // or an assistant message) → it heard the message; no recall.
  if (deps.turnOutput.seen(workerId)) return { recalled: false };

  // Only the exact row this turn's dispatch appended is recallable. Agent-plane
  // dispatches (orchestrator_message / worker_report / loop / …) attach no row,
  // so a turn they started can never recall an older, already-answered
  // user_message — a "latest user_message" lookup here did exactly that.
  const rowId = deps.turnOutput.recallRowId(workerId);
  if (rowId == null) return { recalled: false };
  const row = deps.events.findById(workerId, rowId);
  if (!row) return { recalled: false };

  let text = "";
  let clientMsgId: string | undefined;
  try {
    const payload = JSON.parse(row.payload ?? "{}") as { text?: string; clientMsgIds?: string[] };
    text = payload.text ?? "";
    if (Array.isArray(payload.clientMsgIds) && payload.clientMsgIds.length > 0) {
      clientMsgId = payload.clientMsgIds[0];
    }
  } catch {
    // Malformed payload — still recall (hide the bubble) with empty text.
  }

  // Drop the dispatched ledger/claim row so it can't yield a false
  // hasRecentDispatch hit or orphan idempotency claim. A keyless send leaves
  // only an unaddressable audit row (a harmless ~10s breadcrumb) — nothing to drop.
  if (clientMsgId) deps.queue.removeDispatchedByClientMsgId(workerId, clientMsgId);

  // Consume the target: the recall ends the turn, and a second interrupt must
  // never recall (and roll back) the same row twice.
  deps.turnOutput.reset(workerId);

  return { recalled: true, text, ...(clientMsgId ? { clientMsgId } : {}), rowId: row.id };
}
