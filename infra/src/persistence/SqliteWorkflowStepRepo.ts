// SqliteWorkflowStepRepo — workflow_steps table, the per-node result journal that
// doubles as the resume cursor + memoization index (clone of SqliteLoopStateRepo
// conventions). Prepared statements cached on the instance, snake_case↔camelCase
// mapper, safeStringify for output_json.
//
// The PK is the composite ${runId}:${nodeId} (the DTO's own `id`), so findByNode
// is a primary-key lookup — the cheapest possible memoized-replay path: a `passed`
// row returns its journaled output instead of re-spawning. upsert preserves the
// original started_at across re-writes (the journal's start is stamped once); a
// row with corrupt output_json or one that fails WorkflowStepSchema is skipped on
// read, never thrown.

import type { DatabaseSync } from "node:sqlite";
import type { WorkflowStepRepo } from "../../../core/src/ports/WorkflowStepRepo.ts";
import {
  WorkflowStepSchema,
  type WorkflowStep,
  type StepStatus,
} from "../../../contracts/src/workflow.ts";
import { safeStringify } from "../util/json.ts";

type Row = Record<string, unknown>;

function stepId(runId: string, nodeId: string): string {
  return `${runId}:${nodeId}`;
}

function toWorkflowStep(r: Row): WorkflowStep | null {
  let output: unknown;
  try {
    if (typeof r.output_json === "string") output = JSON.parse(r.output_json);
  } catch {
    return null;
  }
  const candidate = {
    id: r.id,
    runId: r.run_id,
    nodeId: r.node_id,
    nodeType: r.node_type,
    status: r.status,
    workerId: (r.worker_id as string | null) ?? null,
    ...(output !== undefined ? { output } : {}),
    startedAt: r.started_at,
    endedAt: (r.ended_at as number | null) ?? null,
  };
  const res = WorkflowStepSchema.safeParse(candidate);
  return res.success ? res.data : null;
}

export class SqliteWorkflowStepRepo implements WorkflowStepRepo {
  private readonly stmtUpsert;
  private readonly stmtListByRun;
  private readonly stmtFindById;
  private readonly stmtSetStatus;
  private readonly stmtSetOutput;
  private readonly stmtSetWorker;

  constructor(db: DatabaseSync) {
    // UPSERT on the composite PK. started_at is excluded from the update set so
    // the journal's original start survives a re-upsert (status/output progress).
    this.stmtUpsert = db.prepare(`
      INSERT INTO workflow_steps
        (id, run_id, node_id, node_type, status, worker_id, output_json, started_at, ended_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        node_type = excluded.node_type,
        status = excluded.status,
        worker_id = excluded.worker_id,
        output_json = excluded.output_json,
        ended_at = excluded.ended_at
    `);
    this.stmtListByRun = db.prepare("SELECT * FROM workflow_steps WHERE run_id = ? ORDER BY started_at ASC");
    this.stmtFindById = db.prepare("SELECT * FROM workflow_steps WHERE id = ?");
    this.stmtSetStatus = db.prepare("UPDATE workflow_steps SET status = ? WHERE id = ?");
    this.stmtSetOutput = db.prepare("UPDATE workflow_steps SET output_json = ? WHERE id = ?");
    this.stmtSetWorker = db.prepare("UPDATE workflow_steps SET worker_id = ? WHERE id = ?");
  }

  upsert(row: WorkflowStep): void {
    this.stmtUpsert.run(
      row.id,
      row.runId,
      row.nodeId,
      row.nodeType,
      row.status,
      row.workerId,
      row.output !== undefined ? safeStringify(row.output) : null,
      row.startedAt,
      row.endedAt,
    );
  }

  listByRun(runId: string): WorkflowStep[] {
    return (this.stmtListByRun.all(runId) as Row[]).map(toWorkflowStep).filter((x): x is WorkflowStep => x !== null);
  }

  findByNode(runId: string, nodeId: string): WorkflowStep | null {
    const r = this.stmtFindById.get(stepId(runId, nodeId)) as Row | undefined;
    return r ? toWorkflowStep(r) : null;
  }

  setStatus(runId: string, nodeId: string, status: StepStatus): void {
    this.stmtSetStatus.run(status, stepId(runId, nodeId));
  }

  setOutput(runId: string, nodeId: string, output: unknown): void {
    this.stmtSetOutput.run(output !== undefined ? safeStringify(output) : null, stepId(runId, nodeId));
  }

  setWorker(runId: string, nodeId: string, workerId: string): void {
    this.stmtSetWorker.run(workerId, stepId(runId, nodeId));
  }
}
