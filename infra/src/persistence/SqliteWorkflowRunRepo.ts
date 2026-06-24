// SqliteWorkflowRunRepo — workflow_runs table, the status-lifecycle entity
// (clone of SqliteLoopStateRepo). Prepared statements cached on the instance,
// snake_case↔camelCase mapper, safeStringify for the *_json columns, Date.now()
// for the audit timestamps stamped on mutation (the port carries no clock).
//
// Unlike the loop repo (which takes an InsertLoopInput and forces status='active'),
// insert here persists the full parsed WorkflowRun DTO verbatim — the caller owns
// the run's initial status/timestamps. A row whose args_json/result_json is
// corrupt, or that fails WorkflowRunSchema, is skipped on read (never thrown),
// mirroring the validate-on-read skip in SqliteRuntimeWorkerDefinitionStore.

import type { DatabaseSync } from "node:sqlite";
import type { WorkflowRunRepo } from "../../../core/src/ports/WorkflowRunRepo.ts";
import {
  WorkflowRunSchema,
  type WorkflowRun,
  type WorkflowRunStatus,
} from "../../../contracts/src/workflow.ts";
import { safeStringify } from "../util/json.ts";

type Row = Record<string, unknown>;

function toWorkflowRun(r: Row): WorkflowRun | null {
  let args: unknown;
  let result: unknown;
  try {
    if (typeof r.args_json === "string") args = JSON.parse(r.args_json);
    if (typeof r.result_json === "string") result = JSON.parse(r.result_json);
  } catch {
    return null;
  }
  const candidate = {
    id: r.id,
    definitionName: (r.definition_name as string | null) ?? null,
    owner: r.owner,
    anchorId: r.anchor_id,
    status: r.status,
    ...(args !== undefined ? { args } : {}),
    ...(result !== undefined ? { result } : {}),
    startedAt: r.started_at,
    updatedAt: r.updated_at,
  };
  const res = WorkflowRunSchema.safeParse(candidate);
  return res.success ? res.data : null;
}

export class SqliteWorkflowRunRepo implements WorkflowRunRepo {
  private readonly stmtInsert;
  private readonly stmtFindById;
  private readonly stmtListActive;
  private readonly stmtListByOwner;
  private readonly stmtSetStatus;
  private readonly stmtSetResult;

  constructor(db: DatabaseSync) {
    this.stmtInsert = db.prepare(`
      INSERT INTO workflow_runs
        (id, definition_name, owner, anchor_id, status, args_json, result_json, started_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.stmtFindById = db.prepare("SELECT * FROM workflow_runs WHERE id = ?");
    this.stmtListActive = db.prepare(
      "SELECT * FROM workflow_runs WHERE status IN ('pending', 'running') ORDER BY started_at ASC",
    );
    this.stmtListByOwner = db.prepare("SELECT * FROM workflow_runs WHERE owner = ? ORDER BY started_at ASC");
    this.stmtSetStatus = db.prepare("UPDATE workflow_runs SET status = ?, updated_at = ? WHERE id = ?");
    this.stmtSetResult = db.prepare("UPDATE workflow_runs SET result_json = ?, updated_at = ? WHERE id = ?");
  }

  insert(row: WorkflowRun): void {
    this.stmtInsert.run(
      row.id,
      row.definitionName,
      row.owner,
      row.anchorId,
      row.status,
      row.args !== undefined ? safeStringify(row.args) : null,
      row.result !== undefined ? safeStringify(row.result) : null,
      row.startedAt,
      row.updatedAt,
    );
  }

  findById(id: string): WorkflowRun | null {
    const r = this.stmtFindById.get(id) as Row | undefined;
    return r ? toWorkflowRun(r) : null;
  }

  listActive(): WorkflowRun[] {
    return (this.stmtListActive.all() as Row[]).map(toWorkflowRun).filter((x): x is WorkflowRun => x !== null);
  }

  listByOwner(ownerId: string): WorkflowRun[] {
    return (this.stmtListByOwner.all(ownerId) as Row[]).map(toWorkflowRun).filter((x): x is WorkflowRun => x !== null);
  }

  setStatus(id: string, status: WorkflowRunStatus): void {
    this.stmtSetStatus.run(status, Date.now(), id);
  }

  setResult(id: string, result: unknown): void {
    this.stmtSetResult.run(result !== undefined ? safeStringify(result) : null, Date.now(), id);
  }
}
