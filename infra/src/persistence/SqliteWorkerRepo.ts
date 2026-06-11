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
  private readonly stmtListByParent;
  private readonly stmtListOrchestrators;
  private readonly stmtUpdateState;
  private readonly stmtSetTurnStartedAt;
  private readonly stmtMarkDone;
  private readonly stmtAddUsage;
  private readonly stmtIncrementToolCalls;
  private readonly stmtUpdateName;
  private readonly stmtUpdatePermissionMode;
  private readonly stmtUpdateModel;
  private readonly stmtSetWorktreeDir;
  private readonly stmtSetForkBaseSha;
  private readonly stmtSetSessionId;
  private readonly stmtClearRuntime;
  private readonly stmtReactivate;
  private readonly stmtDelete;
  private readonly stmtFindChildrenIds;
  private readonly stmtCountByState;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.stmtInsert = db.prepare(`
      INSERT INTO workers (id, state, cwd, worktree_from, branch, prompt, name, pid, port, started_at, parent_id, model, effort, is_orchestrator, backend_kind, backend_profile, agent_role, with_gateway, turn_started_at, worktree_dir, workspace_owner_id)
      VALUES (?, 'SPAWNING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.stmtFindById = db.prepare("SELECT * FROM workers WHERE id = ?");
    this.stmtListAll = db.prepare("SELECT * FROM workers ORDER BY started_at DESC");
    this.stmtListByParent = db.prepare("SELECT * FROM workers WHERE parent_id = ? ORDER BY started_at DESC");
    this.stmtListOrchestrators = db.prepare("SELECT * FROM workers WHERE is_orchestrator = 1 ORDER BY started_at ASC");
    this.stmtUpdateState = db.prepare("UPDATE workers SET state = ? WHERE id = ?");
    this.stmtSetTurnStartedAt = db.prepare("UPDATE workers SET turn_started_at = ? WHERE id = ?");
    this.stmtMarkDone = db.prepare("UPDATE workers SET state = 'DONE', ended_at = ?, exit_code = ? WHERE id = ?");
    this.stmtAddUsage = db.prepare(`
      UPDATE workers SET
        tokens_in = COALESCE(tokens_in, 0) + ?,
        tokens_out = COALESCE(tokens_out, 0) + ?,
        tokens_cache_read = COALESCE(tokens_cache_read, 0) + ?,
        tokens_cache_create = COALESCE(tokens_cache_create, 0) + ?,
        tokens_cache_create_1h = COALESCE(tokens_cache_create_1h, 0) + ?,
        cost_usd = COALESCE(cost_usd, 0) + ?
      WHERE id = ?
    `);
    this.stmtIncrementToolCalls = db.prepare(
      "UPDATE workers SET tool_calls = COALESCE(tool_calls, 0) + 1 WHERE id = ?",
    );
    this.stmtUpdateName = db.prepare("UPDATE workers SET name = ? WHERE id = ?");
    this.stmtUpdatePermissionMode = db.prepare("UPDATE workers SET permission_mode = ? WHERE id = ?");
    this.stmtUpdateModel = db.prepare("UPDATE workers SET model = ?, effort = ? WHERE id = ?");
    this.stmtSetWorktreeDir = db.prepare("UPDATE workers SET worktree_dir = ? WHERE id = ?");
    this.stmtSetForkBaseSha = db.prepare("UPDATE workers SET fork_base_sha = ? WHERE id = ?");
    this.stmtSetSessionId = db.prepare("UPDATE workers SET session_id = ? WHERE id = ?");
    this.stmtClearRuntime = db.prepare("UPDATE workers SET pid = NULL, port = NULL WHERE id = ?");
    this.stmtReactivate = db.prepare("UPDATE workers SET pid = ?, port = ?, ended_at = NULL, exit_code = NULL WHERE id = ?");
    this.stmtDelete = db.prepare("DELETE FROM workers WHERE id = ?");
    this.stmtFindChildrenIds = db.prepare("SELECT id FROM workers WHERE parent_id = ?");
    this.stmtCountByState = db.prepare("SELECT state, COUNT(*) AS n FROM workers GROUP BY state");
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
      input.effort,
      input.isOrchestrator ? 1 : 0,
      input.backendKind ?? "claude-cli",
      input.backendProfile ?? null,
      input.agentRole ?? null,
      input.withGateway ? 1 : 0,
      input.startedAt,
      input.worktreeDir ?? null,
      input.workspaceOwnerId ?? null,
    );
  }

  findById(id: string): WorkerRow | null {
    const row = this.stmtFindById.get(id) as Row | undefined;
    return row ? (row as unknown as WorkerRow) : null;
  }

  listAll(): WorkerRow[] {
    return this.stmtListAll.all() as unknown as WorkerRow[];
  }

  listByParent(parentId: string): WorkerRow[] {
    return this.stmtListByParent.all(parentId) as unknown as WorkerRow[];
  }

  listOrchestrators(): WorkerRow[] {
    return this.stmtListOrchestrators.all() as unknown as WorkerRow[];
  }

  updateState(id: string, state: WorkerState): void {
    this.stmtUpdateState.run(state, id);
  }

  setTurnStartedAt(id: string, ts: number): void {
    this.stmtSetTurnStartedAt.run(ts, id);
  }

  markDone(id: string, endedAt: number, exitCode: number | null): void {
    this.stmtMarkDone.run(endedAt, exitCode, id);
  }

  addUsage(id: string, delta: UsageDelta): void {
    this.stmtAddUsage.run(delta.in, delta.out, delta.cacheRead, delta.cacheCreate, delta.cacheCreate1h, delta.costUsd, id);
  }

  incrementToolCalls(id: string): void {
    this.stmtIncrementToolCalls.run(id);
  }

  updateName(id: string, name: string | null): void {
    this.stmtUpdateName.run(name, id);
  }

  updatePermissionMode(id: string, mode: string): void {
    this.stmtUpdatePermissionMode.run(mode, id);
  }

  updateModel(id: string, model: string, effort: string | null): void {
    this.stmtUpdateModel.run(model, effort, id);
  }

  setWorktreeDir(id: string, worktreeDir: string): void {
    this.stmtSetWorktreeDir.run(worktreeDir, id);
  }

  setForkBaseSha(id: string, sha: string): void {
    this.stmtSetForkBaseSha.run(sha, id);
  }

  setSessionId(id: string, sessionId: string): void {
    this.stmtSetSessionId.run(sessionId, id);
  }

  clearRuntime(id: string): void {
    this.stmtClearRuntime.run(id);
  }

  reactivate(id: string, runtime: { pid: number | null; port: number }): void {
    this.stmtReactivate.run(runtime.pid, runtime.port, id);
  }

  delete(id: string): void {
    this.stmtDelete.run(id);
  }

  findChildrenIds(parentId: string): string[] {
    const rows = this.stmtFindChildrenIds.all(parentId) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  countByState(): Array<{ state: string; n: number }> {
    return this.stmtCountByState.all() as Array<{ state: string; n: number }>;
  }
}
