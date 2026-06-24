// WorkflowRunRepo — persistence port for run-lifecycle rows (workflow_runs), a
// clone of the worker_loops status-lifecycle entity (§3.7). The adapter is
// SqliteWorkflowRunRepo in infra/persistence/. `listActive()` (status IN pending,
// running) is the boot re-arm cursor (reArmWorkflows). The row is the camelCase
// parsed DTO from contracts; the adapter does the *_json round-trip at its edge.

import type { WorkflowRun as WorkflowRunRow, WorkflowRunStatus } from "../../../contracts/src/workflow.ts";

export interface WorkflowRunRepo {
  insert(row: WorkflowRunRow): void;
  findById(id: string): WorkflowRunRow | null;
  listActive(): WorkflowRunRow[];                 // status IN (pending, running) — boot re-arm
  listByOwner(ownerId: string): WorkflowRunRow[];
  setStatus(id: string, status: WorkflowRunStatus): void;
  setResult(id: string, result: unknown): void;
}
