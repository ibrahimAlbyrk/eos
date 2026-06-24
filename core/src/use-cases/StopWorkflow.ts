// StopWorkflow — transition a non-terminal run to `stopped` and publish the change
// (§3.8). The use-case stays pure: the in-memory AbortController and the recursive
// killWorker(anchorId) live in the manager service (a later phase), injected here
// as an `abort` callback so the engine's run() finally-teardown reaps the anchor
// subtree. A run already in a terminal state is returned unchanged (idempotent).

import { NotFoundError } from "../errors/index.ts";
import type { WorkflowRunRepo } from "../ports/WorkflowRunRepo.ts";
import type { ProgressSink } from "../ports/ProgressSink.ts";
import type { WorkflowRunStatus } from "../../../contracts/src/workflow.ts";

const TERMINAL: ReadonlySet<WorkflowRunStatus> = new Set(["passed", "failed", "stopped"]);

export interface StopWorkflowDeps {
  runs: WorkflowRunRepo;
  progress: ProgressSink;
}

export interface StopWorkflowInput {
  runId: string;
  // Manager-owned teardown: abort the run's AbortController + killWorker(anchorId).
  abort?: () => void;
}

export function stopWorkflow(
  deps: StopWorkflowDeps,
  input: StopWorkflowInput,
): { runId: string; status: WorkflowRunStatus } {
  const row = deps.runs.findById(input.runId);
  if (!row) throw new NotFoundError("workflow run", input.runId);
  if (TERMINAL.has(row.status)) return { runId: row.id, status: row.status };

  deps.runs.setStatus(row.id, "stopped");
  input.abort?.();
  deps.progress.runChanged(row.id, "stopped");
  return { runId: row.id, status: "stopped" };
}
