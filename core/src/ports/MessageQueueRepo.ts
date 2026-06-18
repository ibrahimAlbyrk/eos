// MessageQueueRepo — daemon-side message queue + idempotency ledger in one
// table. A row with dispatchedAt NULL is pending (queued, waiting for the
// worker's next IDLE); a dispatched row stays behind as the dedup ledger for
// its clientMsgId, so a duplicate POST can never become a second turn.
// Adapter is SqliteMessageQueueRepo in infra/persistence/.

import type { DispatchEnvelope } from "../domain/message-envelope.ts";

export interface QueuedMessage {
  id: number;
  workerId: string;
  clientMsgId: string | null;
  text: string;
  createdAt: number;
  /** Agent-plane messages (report/directive/peer) carry their kind + routing so
   *  the drain replays them faithfully instead of as a plain user_message. */
  envelope?: DispatchEnvelope;
  /** What the chat renders instead of `text` (a report's bare body vs the
   *  routing wrapper the model reads). */
  displayText?: string;
}

export interface MessageQueueInsert {
  workerId: string;
  clientMsgId: string | null;
  text: string;
  createdAt: number;
  /** null → pending (queued); set → dispatched (ledger/claim row). */
  dispatchedAt: number | null;
  /** Persisted only for pending rows so the drain can rebuild the dispatch. */
  envelope?: DispatchEnvelope;
  displayText?: string;
}

export interface MessageQueueRepo {
  /** Returns the new row id, or null when (workerId, clientMsgId) already
   *  exists — the duplicate signal callers treat as an idempotent no-op. */
  insert(row: MessageQueueInsert): number | null;
  listPending(workerId: string): QueuedMessage[];
  /** Pending → ledger (drain success). */
  markDispatched(ids: number[], ts: number): void;
  /** Claim rollback after a failed dispatch — deletes regardless of state. */
  removeById(id: number): void;
  /** Pill dismiss — deletes only if still pending. Returns whether a row was removed. */
  removePending(workerId: string, id: number): boolean;
  /** Interrupt semantics: Esc cancels everything the user queued. Deletes all
   *  pending rows for the worker (ledger rows stay); returns how many. */
  clearPending(workerId: string): number;
  /** True when the same text was dispatched to this worker after sinceTs —
   *  the duplicate heuristic for sends that carry no clientMsgId. */
  hasRecentDispatch(workerId: string, text: string, sinceTs: number): boolean;
  deleteByWorker(workerId: string): void;
  /** Drops dispatched ledger rows older than beforeTs (startup hygiene). */
  prune(beforeTs: number): void;
}
