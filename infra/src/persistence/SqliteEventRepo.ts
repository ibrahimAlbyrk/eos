// SqliteEventRepo — append-only events table, bounded per worker.
//
// Retention: the table is otherwise unbounded — a persistent orchestrator's
// rows are never culled (kill is the only DELETE), so a multi-day session grows
// it linearly. Each worker keeps only its newest `maxPerWorker` rows; older ones
// are pruned by id range (never reordering — the "Events query ordering" + cost
// fold-at-append invariants both hold). Prune is amortized: a steady-state check
// every PRUNE_CHECK_EVERY appends per worker, plus a one-shot sweep at startup
// (catches rows that accumulated across daemon restarts). DELETE frees pages but
// doesn't shrink the file — maybeVacuum does that.

import type { DatabaseSync } from "node:sqlite";
import type { WorkerEventRow } from "../../../contracts/src/events.ts";
import type { EventRepo, EventQuery } from "../../../core/src/ports/EventRepo.ts";
import { safeStringify } from "../util/json.ts";

export const PRUNE_CHECK_EVERY = 1000;

export class SqliteEventRepo implements EventRepo {
  private readonly db: DatabaseSync;
  private readonly maxPerWorker: number;
  private readonly appendsSincePrune = new Map<string, number>();
  private readonly stmtInsert;
  private readonly stmtPatchPayload;
  private readonly stmtListAsc;
  private readonly stmtListDesc;
  private readonly stmtListDescBefore;
  private readonly stmtListAfter;
  private readonly stmtLatestOfType;
  private readonly stmtDeleteByWorker;
  private readonly stmtPruneOlder;
  private readonly stmtDistinctWorkers;

  // maxPerWorker <= 0 disables pruning (kept for tests / explicit opt-out).
  constructor(db: DatabaseSync, maxPerWorker = 20000) {
    this.db = db;
    this.maxPerWorker = maxPerWorker;
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
    // Newest single row of a type — direction-agnostic (no window to re-sort).
    // Same ts/id tiebreak as the list queries so same-ms rows resolve by
    // insertion order (the latest user_message a recall must pick).
    this.stmtLatestOfType = db.prepare(
      "SELECT * FROM events WHERE worker_id = ? AND type = ? ORDER BY ts DESC, id DESC LIMIT 1",
    );
    this.stmtDeleteByWorker = db.prepare("DELETE FROM events WHERE worker_id = ?");
    // Keep the newest `keepNewest` rows for a worker; delete everything older.
    // The subquery yields the id of the keepNewest-th newest row (the oldest one
    // we keep) via OFFSET keepNewest-1; `id < that` drops everything below it.
    // When fewer than keepNewest rows exist the subquery is NULL and `id < NULL`
    // deletes nothing.
    this.stmtPruneOlder = db.prepare(
      "DELETE FROM events WHERE worker_id = ? AND id < (SELECT id FROM events WHERE worker_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)",
    );
    this.stmtDistinctWorkers = db.prepare("SELECT DISTINCT worker_id FROM events");
  }

  append(workerId: string, ts: number, type: string, payload: unknown): number {
    const info = this.stmtInsert.run(
      workerId,
      ts,
      type,
      payload === undefined || payload === null ? null : safeStringify(payload),
    );
    this.maybePrune(workerId);
    return Number(info.lastInsertRowid);
  }

  // Amortized retention: only every PRUNE_CHECK_EVERY appends per worker run the
  // delete, so a worker oscillates between maxPerWorker and maxPerWorker+slack.
  private maybePrune(workerId: string): void {
    if (this.maxPerWorker <= 0) return;
    const n = (this.appendsSincePrune.get(workerId) ?? 0) + 1;
    if (n < PRUNE_CHECK_EVERY) { this.appendsSincePrune.set(workerId, n); return; }
    this.appendsSincePrune.set(workerId, 0);
    this.pruneOlderThanRank(workerId, this.maxPerWorker);
  }

  pruneOlderThanRank(workerId: string, keepNewest: number): number {
    if (keepNewest <= 0) return 0;
    const info = this.stmtPruneOlder.run(workerId, workerId, keepNewest - 1);
    return Number(info.changes ?? 0);
  }

  // One-shot startup sweep across every worker — bounds rows that built up over
  // prior daemon sessions (the in-memory append counter resets each restart).
  pruneAll(keepNewest: number): number {
    if (keepNewest <= 0) return 0;
    let removed = 0;
    for (const { worker_id } of this.stmtDistinctWorkers.all() as Array<{ worker_id: string }>) {
      removed += this.pruneOlderThanRank(worker_id, keepNewest);
    }
    return removed;
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

  latestOfType(workerId: string, type: string): WorkerEventRow | null {
    return (this.stmtLatestOfType.get(workerId, type) as WorkerEventRow | undefined) ?? null;
  }

  deleteByWorker(workerId: string): void {
    this.stmtDeleteByWorker.run(workerId);
    this.appendsSincePrune.delete(workerId);
  }

  // Drop the in-memory prune counter for a worker that exited without a DELETE
  // (natural/crash/boot-reconcile exits keep their events row). Called from the
  // daemon's worker:exit handler so the counter map can't grow by one entry per
  // never-killed worker over a long daemon session.
  forgetPruneCounter(workerId: string): void {
    this.appendsSincePrune.delete(workerId);
  }
}
