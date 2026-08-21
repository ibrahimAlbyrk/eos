// EventRepo — append-only event log per worker. Adapter is SqliteEventRepo.

import type { WorkerEventRow, WorkerEventType } from "../../../contracts/src/events.ts";

export interface EventQuery {
  workerId: string;
  since: number;
  limit: number;
  order: "asc" | "desc";
  /** Exclusive upper id bound — backward pagination ("load older"). Desc order only. */
  beforeId?: number;
  /** Exclusive lower id bound — forward delta fetch in id-ASC (insertion)
   *  order. Takes precedence over order/beforeId. */
  afterId?: number;
}

export interface EventRepo {
  /** Returns the row id of the newly inserted event. */
  append(workerId: string, ts: number, type: WorkerEventType, payload: unknown): number;
  /** Patches the payload of an existing row (used by usage delta-cost back-fill). */
  patchPayload(rowId: number, payload: unknown): void;
  list(q: EventQuery): WorkerEventRow[];
  /** All rows of one type for a worker, id-ASC (insertion order). A full
   *  per-worker scan bounded by the same maxPerWorker retention `list` relies
   *  on. `opts.limit` caps the result (omit → every retained row). Used by the
   *  attachments read to walk every user_message across the conversation. */
  listByType(workerId: string, type: WorkerEventType, opts?: { limit?: number }): WorkerEventRow[];
  /** Exact-row fetch by id, or null when gone (pruned/deleted). The workerId
   *  guard keeps a stale id from ever addressing another worker's row. */
  findById(workerId: string, rowId: number): WorkerEventRow | null;
  deleteByWorker(workerId: string): void;
}
