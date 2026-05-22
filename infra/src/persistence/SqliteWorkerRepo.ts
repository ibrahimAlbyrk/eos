// SqliteWorkerRepo — SQLite-backed WorkerRepo. Every prepared statement is
// cached on the instance so the hot paths don't re-parse SQL.

import type { DatabaseSync } from "node:sqlite";
import type { WorkerRow } from "../../../contracts/src/worker.ts";
import type { WorkerState } from "../../../contracts/src/events.ts";
import type { WorkerRepo, InsertWorkerInput, UsageDelta } from "../../../core/src/ports/WorkerRepo.ts";

type Row = Record<string, unknown>;

export class SqliteWorkerRepo implements WorkerRepo {
  private readonly db: DatabaseSync;
  private readonly stmtInsert;
  private readonly stmtFindById;
  private readonly stmtListAll;
  private readonly stmtListOrchestrators;
  private readonly stmtUpdateState;
  private readonly stmtMarkDone;
  private readonly stmtAddUsage;
  private readonly stmtDelete;
  private readonly stmtTotalCost;
  private readonly stmtCountByState;
  private readonly stmtCountActive;
  private readonly stmtEarliestOrch;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.stmtInsert = db.prepare(`
      INSERT INTO workers (id, state, cwd, worktree_from, branch, prompt, name, pid, port, started_at, parent_id, model, is_orchestrator)
      VALUES (?, 'SPAWNING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.stmtFindById = db.prepare("SELECT * FROM workers WHERE id = ?");
    this.stmtListAll = db.prepare("SELECT * FROM workers ORDER BY started_at DESC");
    this.stmtListOrchestrators = db.prepare("SELECT * FROM workers WHERE is_orchestrator = 1 ORDER BY started_at ASC");
    this.stmtUpdateState = db.prepare("UPDATE workers SET state = ? WHERE id = ?");
    this.stmtMarkDone = db.prepare("UPDATE workers SET state = 'DONE', ended_at = ?, exit_code = ? WHERE id = ?");
    this.stmtAddUsage = db.prepare(`
      UPDATE workers SET
        tokens_in = COALESCE(tokens_in, 0) + ?,
        tokens_out = COALESCE(tokens_out, 0) + ?,
        tokens_cache_read = COALESCE(tokens_cache_read, 0) + ?,
        tokens_cache_create = COALESCE(tokens_cache_create, 0) + ?,
        cost_usd = COALESCE(cost_usd, 0) + ?
      WHERE id = ?
    `);
    this.stmtDelete = db.prepare("DELETE FROM workers WHERE id = ?");
    this.stmtTotalCost = db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM workers");
    this.stmtCountByState = db.prepare("SELECT state, COUNT(*) AS n FROM workers GROUP BY state");
    this.stmtCountActive = db.prepare(
      "SELECT COUNT(*) AS total, COUNT(CASE WHEN state IN ('SPAWNING','WORKING','IDLE') THEN 1 END) AS active FROM workers",
    );
    this.stmtEarliestOrch = db.prepare(
      "SELECT started_at FROM workers WHERE is_orchestrator = 1 ORDER BY started_at ASC LIMIT 1",
    );
  }

  insert(input: InsertWorkerInput): void {
    this.stmtInsert.run(
      input.id,
      input.cwd,
      input.worktreeFrom,
      input.branch,
      input.prompt,
      input.name,
      input.pid,
      input.port,
      input.startedAt,
      input.parentId,
      input.model,
      input.isOrchestrator ? 1 : 0,
    );
  }

  findById(id: string): WorkerRow | null {
    const row = this.stmtFindById.get(id) as Row | undefined;
    return row ? (row as unknown as WorkerRow) : null;
  }

  listAll(): WorkerRow[] {
    return this.stmtListAll.all() as unknown as WorkerRow[];
  }

  listOrchestrators(): WorkerRow[] {
    return this.stmtListOrchestrators.all() as unknown as WorkerRow[];
  }

  updateState(id: string, state: WorkerState): void {
    this.stmtUpdateState.run(state, id);
  }

  markDone(id: string, endedAt: number, exitCode: number | null): void {
    this.stmtMarkDone.run(endedAt, exitCode, id);
  }

  addUsage(id: string, delta: UsageDelta): void {
    this.stmtAddUsage.run(delta.in, delta.out, delta.cacheRead, delta.cacheCreate, delta.costUsd, id);
  }

  delete(id: string): void {
    this.stmtDelete.run(id);
  }

  totalCost(): number {
    return (this.stmtTotalCost.get() as { total?: number } | undefined)?.total ?? 0;
  }

  countByState(): Array<{ state: string; n: number }> {
    return this.stmtCountByState.all() as Array<{ state: string; n: number }>;
  }

  countActive(): { active: number; total: number } {
    const row = this.stmtCountActive.get() as { active?: number; total?: number } | undefined;
    return { active: row?.active ?? 0, total: row?.total ?? 0 };
  }

  earliestOrchestratorStart(): number | null {
    const row = this.stmtEarliestOrch.get() as { started_at?: number } | undefined;
    return row?.started_at ?? null;
  }
}
