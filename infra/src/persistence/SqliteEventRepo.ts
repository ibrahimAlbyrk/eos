// SqliteEventRepo — append-only events table.

import type { DatabaseSync } from "node:sqlite";
import type { WorkerEventRow } from "../../../contracts/src/events.ts";
import type { EventRepo, EventQuery } from "../../../core/src/ports/EventRepo.ts";
import { safeStringify } from "../util/json.ts";

export class SqliteEventRepo implements EventRepo {
  private readonly db: DatabaseSync;
  private readonly stmtInsert;
  private readonly stmtPatchPayload;
  private readonly stmtListAsc;
  private readonly stmtListDesc;
  private readonly stmtListDescBefore;
  private readonly stmtListAfter;
  private readonly stmtDeleteByWorker;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.stmtInsert = db.prepare("INSERT INTO events (worker_id, ts, type, payload) VALUES (?, ?, ?, ?)");
    this.stmtPatchPayload = db.prepare("UPDATE events SET payload = ? WHERE id = ?");
    // Newest-N-in-ASC-order — the daemon's default response shape for callers
    // that want "recent events" in chronological reading order.
    // `id` tiebreak: same-ms events must keep insertion order — the web's
    // tool-lifecycle barriers (Stop/exit close open tools) depend on it.
    this.stmtListDesc = db.prepare(
      "SELECT * FROM (SELECT * FROM events WHERE worker_id = ? AND ts > ? ORDER BY ts DESC, id DESC LIMIT ?) ORDER BY ts ASC, id ASC",
    );
    // Backward pagination — newest N strictly older (by id) than the cursor,
    // same ASC reading order. `id` cursor, not ts: same-ms rows would be
    // skipped or duplicated across pages with a ts cursor.
    this.stmtListDescBefore = db.prepare(
      "SELECT * FROM (SELECT * FROM events WHERE worker_id = ? AND ts > ? AND id < ? ORDER BY ts DESC, id DESC LIMIT ?) ORDER BY ts ASC, id ASC",
    );
    // Forward pagination — oldest-first after `since`. The web data layer
    // loops with the last-seen ts as the next cursor.
    this.stmtListAsc = db.prepare(
      "SELECT * FROM events WHERE worker_id = ? AND ts > ? ORDER BY ts ASC, id ASC LIMIT ?",
    );
    // Delta fetch — rows appended after an id cursor, in insertion order.
    // id, not ts: same-ms rows would be skipped or duplicated with a ts cursor.
    this.stmtListAfter = db.prepare(
      "SELECT * FROM events WHERE worker_id = ? AND id > ? ORDER BY id ASC LIMIT ?",
    );
    this.stmtDeleteByWorker = db.prepare("DELETE FROM events WHERE worker_id = ?");
  }

  append(workerId: string, ts: number, type: string, payload: unknown): number {
    const info = this.stmtInsert.run(
      workerId,
      ts,
      type,
      payload === undefined || payload === null ? null : safeStringify(payload),
    );
    return Number(info.lastInsertRowid);
  }

  patchPayload(rowId: number, payload: unknown): void {
    this.stmtPatchPayload.run(safeStringify(payload), rowId);
  }

  list(q: EventQuery): WorkerEventRow[] {
    if (q.afterId != null) {
      return this.stmtListAfter.all(q.workerId, q.afterId, q.limit) as unknown as WorkerEventRow[];
    }
    if (q.order === "desc" && q.beforeId != null) {
      return this.stmtListDescBefore.all(q.workerId, q.since, q.beforeId, q.limit) as unknown as WorkerEventRow[];
    }
    const stmt = q.order === "asc" ? this.stmtListAsc : this.stmtListDesc;
    return stmt.all(q.workerId, q.since, q.limit) as unknown as WorkerEventRow[];
  }

  deleteByWorker(workerId: string): void {
    this.stmtDeleteByWorker.run(workerId);
  }
}
