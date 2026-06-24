// RecallPendingTurn — the DECISION behind "interrupt before the agent responded
// → recall the just-sent message". Pure: it reads the turn-output signal, finds
// the bubble to recall, drops the dispatch ledger row, and returns what the
// daemon must hide + restore. The side effects (emit the message_recalled
// marker, roll back the SDK context, restore the composer) live in the outer
// layers — the handler owns them.
//
// Two outcomes:
//   - output already seen this turn → { recalled: false } (the agent heard the
//     message; the handler does a normal interrupt, no recall).
//   - output empty → { recalled: true, ... } carrying the last user_message's
//     text + clientMsgId + its event row id, ledger row dropped.
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

// How many recent events to scan back for the user_message. In the output-empty
// case the user_message sits among the last few rows (its WORKING/IDLE state
// rows are the only siblings), so a small window is ample.
const SCAN_LIMIT = 50;

export function recallPendingTurn(
  deps: RecallPendingTurnDeps,
  workerId: string,
): RecallPendingTurnResult {
  // The agent already produced output this turn (first delta on either channel,
  // or an assistant message) → it heard the message; no recall.
  if (deps.turnOutput.seen(workerId)) return { recalled: false };

  // The most recent user_message is the just-dispatched bubble to recall. Walk
  // newest-first; only the latest unanswered one is recalled (earlier ones may
  // have been answered).
  const rows = deps.events.list({ workerId, since: 0, limit: SCAN_LIMIT, order: "desc" });
  const row = rows.find((r) => r.type === "user_message");
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

  return { recalled: true, text, ...(clientMsgId ? { clientMsgId } : {}), rowId: row.id };
}
