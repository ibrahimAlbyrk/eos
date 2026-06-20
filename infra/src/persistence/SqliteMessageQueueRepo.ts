// SqliteMessageQueueRepo — queued_messages table (queue + idempotency ledger).

import type { DatabaseSync } from "node:sqlite";
import type { MessageQueueRepo, MessageQueueInsert, QueuedMessage } from "../../../core/src/ports/MessageQueueRepo.ts";
import type { DispatchEnvelope } from "../../../core/src/domain/message-envelope.ts";

interface Row {
  id: number;
  worker_id: string;
  client_msg_id: string | null;
  text: string;
  created_at: number;
  meta: string | null;
}

// Agent-plane routing (envelope + displayText) is persisted as one JSON column
// so a report/directive/peer message queued behind a busy parent replays as its
// real kind, not a plain user_message. A malformed/legacy NULL row degrades to
// a plain message — never throws the drain.
interface QueueMeta {
  envelope?: DispatchEnvelope;
  displayText?: string;
}

function encodeMeta(envelope?: DispatchEnvelope, displayText?: string): string | null {
  if (!envelope && displayText == null) return null;
  return JSON.stringify({ envelope, displayText });
}

function decodeMeta(meta: string | null): QueueMeta {
  if (!meta) return {};
  try {
    return JSON.parse(meta) as QueueMeta;
  } catch {
    return {};
  }
}

function toQueuedMessage(r: Row): QueuedMessage {
  const { envelope, displayText } = decodeMeta(r.meta);
  return {
    id: r.id,
    workerId: r.worker_id,
    clientMsgId: r.client_msg_id,
    text: r.text,
    createdAt: r.created_at,
    ...(envelope ? { envelope } : {}),
    ...(displayText != null ? { displayText } : {}),
  };
}

export class SqliteMessageQueueRepo implements MessageQueueRepo {
  private readonly stmtInsert;
  private readonly stmtListPending;
  private readonly stmtListPendingUser;
  private readonly stmtMarkDispatched;
  private readonly stmtRemoveById;
  private readonly stmtRemovePending;
  private readonly stmtClearPending;
  private readonly stmtClearPendingUser;
  private readonly stmtHasRecent;
  private readonly stmtDeleteByWorker;
  private readonly stmtPrune;

  constructor(db: DatabaseSync) {
    // ON CONFLICT DO NOTHING + changes check = the idempotency primitive; the
    // unique index ignores NULL client_msg_id rows (audit entries), so only
    // keyed messages dedup.
    this.stmtInsert = db.prepare(
      "INSERT INTO queued_messages (worker_id, client_msg_id, text, created_at, dispatched_at, meta, plane) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(worker_id, client_msg_id) DO NOTHING",
    );
    this.stmtListPending = db.prepare(
      "SELECT id, worker_id, client_msg_id, text, created_at, meta FROM queued_messages WHERE worker_id = ? AND dispatched_at IS NULL ORDER BY id ASC",
    );
    this.stmtListPendingUser = db.prepare(
      "SELECT id, worker_id, client_msg_id, text, created_at, meta FROM queued_messages WHERE worker_id = ? AND dispatched_at IS NULL AND plane = 'user' ORDER BY id ASC",
    );
    this.stmtMarkDispatched = db.prepare("UPDATE queued_messages SET dispatched_at = ? WHERE id = ?");
    this.stmtRemoveById = db.prepare("DELETE FROM queued_messages WHERE id = ?");
    this.stmtRemovePending = db.prepare(
      "DELETE FROM queued_messages WHERE worker_id = ? AND id = ? AND dispatched_at IS NULL",
    );
    this.stmtClearPending = db.prepare(
      "DELETE FROM queued_messages WHERE worker_id = ? AND dispatched_at IS NULL",
    );
    this.stmtClearPendingUser = db.prepare(
      "DELETE FROM queued_messages WHERE worker_id = ? AND plane = 'user' AND dispatched_at IS NULL",
    );
    this.stmtHasRecent = db.prepare(
      "SELECT 1 AS hit FROM queued_messages WHERE worker_id = ? AND text = ? AND dispatched_at > ? LIMIT 1",
    );
    this.stmtDeleteByWorker = db.prepare("DELETE FROM queued_messages WHERE worker_id = ?");
    this.stmtPrune = db.prepare("DELETE FROM queued_messages WHERE dispatched_at IS NOT NULL AND dispatched_at < ?");
  }

  insert(row: MessageQueueInsert): number | null {
    const meta = encodeMeta(row.envelope, row.displayText);
    const info = this.stmtInsert.run(row.workerId, row.clientMsgId, row.text, row.createdAt, row.dispatchedAt, meta, row.plane ?? "user");
    return info.changes === 0 ? null : Number(info.lastInsertRowid);
  }

  listPending(workerId: string): QueuedMessage[] {
    return (this.stmtListPending.all(workerId) as unknown as Row[]).map(toQueuedMessage);
  }

  listPendingUserPlane(workerId: string): QueuedMessage[] {
    return (this.stmtListPendingUser.all(workerId) as unknown as Row[]).map(toQueuedMessage);
  }

  markDispatched(ids: number[], ts: number): void {
    for (const id of ids) this.stmtMarkDispatched.run(ts, id);
  }

  removeById(id: number): void {
    this.stmtRemoveById.run(id);
  }

  removePending(workerId: string, id: number): boolean {
    return this.stmtRemovePending.run(workerId, id).changes > 0;
  }

  clearPending(workerId: string): number {
    return Number(this.stmtClearPending.run(workerId).changes);
  }

  clearPendingUserPlane(workerId: string): number {
    return Number(this.stmtClearPendingUser.run(workerId).changes);
  }

  hasRecentDispatch(workerId: string, text: string, sinceTs: number): boolean {
    return this.stmtHasRecent.get(workerId, text, sinceTs) !== undefined;
  }

  deleteByWorker(workerId: string): void {
    this.stmtDeleteByWorker.run(workerId);
  }

  prune(beforeTs: number): void {
    this.stmtPrune.run(beforeTs);
  }
}
