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
  /** Exact-row fetch by id, or null when gone (pruned/deleted). The workerId
   *  guard keeps a stale id from ever addressing another worker's row. */
  findById(workerId: string, rowId: number): WorkerEventRow | null;
  deleteByWorker(workerId: string): void;
}
