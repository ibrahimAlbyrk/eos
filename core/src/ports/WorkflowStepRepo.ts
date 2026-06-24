// WorkflowStepRepo — the per-node result journal (workflow_steps), which doubles
// as the resume cursor + memoization index (§3.4/§3.7). The adapter is
// SqliteWorkflowStepRepo in infra/persistence/. `findByNode(runId, nodeId)` drives
// memoized replay: a `passed` row returns its journaled output instead of
// re-spawning. `setStatus`/`setOutput` let the step-output route persist a
// completion durably the instant a report is observed (crash-correctness). The row
// is the camelCase parsed DTO from contracts.

import type { WorkflowStep as WorkflowStepRow, StepStatus } from "../../../contracts/src/workflow.ts";

export interface WorkflowStepRepo {
  upsert(row: WorkflowStepRow): void;
  listByRun(runId: string): WorkflowStepRow[];
  findByNode(runId: string, nodeId: string): WorkflowStepRow | null;  // memoized replay
  setStatus(runId: string, nodeId: string, status: StepStatus): void;
  setOutput(runId: string, nodeId: string, output: unknown): void;
  // Stamp a step-worker id onto the `running` row at spawn time so the worker that
  // is in-flight is durably linked to its node BEFORE its report lands. This is
  // what lets the boot re-arm recover an unjournaled completion: it matches a
  // durable `worker_report` (payload.fromWorker) against `running` steps by this
  // id, rather than re-spawning a step that already finished (§3.7).
  setWorker(runId: string, nodeId: string, workerId: string): void;
}
