// SqliteContextMarkRepo — worker_context_marks table (context-threshold latch).
// mark() leans on INSERT ... ON CONFLICT DO NOTHING + the changes count: the
// composite PK (worker_id, stage) makes the first insert win (changes===1) and
// every repeat a no-op (changes===0), so the warn/full heads-up fires exactly
// once per context epoch. Mirrors SqliteMessageQueueRepo's idempotency primitive.

import type { DatabaseSync } from "node:sqlite";
import type { ContextMarkRepo } from "../../../core/src/ports/ContextMarkRepo.ts";
import type { Clock } from "../../../core/src/ports/Clock.ts";

export class SqliteContextMarkRepo implements ContextMarkRepo {
  private readonly clock: Clock;
  private readonly stmtMark;
  private readonly stmtClear;
  private readonly stmtHas;

  constructor(db: DatabaseSync, clock: Clock) {
    this.clock = clock;
    this.stmtMark = db.prepare(
      "INSERT INTO worker_context_marks (worker_id, stage, marked_at) VALUES (?, ?, ?) ON CONFLICT(worker_id, stage) DO NOTHING",
    );
    this.stmtClear = db.prepare("DELETE FROM worker_context_marks WHERE worker_id = ?");
    this.stmtHas = db.prepare("SELECT 1 AS hit FROM worker_context_marks WHERE worker_id = ? AND stage = ? LIMIT 1");
  }

  mark(workerId: string, stage: "warn90" | "full"): boolean {
    return this.stmtMark.run(workerId, stage, this.clock.now()).changes === 1;
  }

  clear(workerId: string): void {
    this.stmtClear.run(workerId);
  }

  has(workerId: string, stage: string): boolean {
    return this.stmtHas.get(workerId, stage) != null;
  }
}
