// ResumeWorkflow — re-drive an interrupted run after a daemon restart (boot
// re-arm). The engine's resume() reuses the synthetic anchor row, re-spawns the
// (never-journaled) experts, and replays journaled-`passed` steps from their
// memoized output instead of re-spawning. Thin glue over engine.resume().

import type { WorkflowEngine, WorkflowRunResult } from "../ports/WorkflowEngine.ts";

export interface ResumeWorkflowDeps {
  engine: WorkflowEngine;
}

export interface ResumeWorkflowInput {
  runId: string;
  ownerId: string;
  mode: string;
  signal?: AbortSignal;
}

export function resumeWorkflow(deps: ResumeWorkflowDeps, input: ResumeWorkflowInput): Promise<WorkflowRunResult> {
  return deps.engine.resume(input.runId, {
    runId: input.runId,
    ownerId: input.ownerId,
    mode: input.mode,
    signal: input.signal,
  });
}
