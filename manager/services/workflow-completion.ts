// renderWorkflowCompletion — format a finished workflow run as the message body
// delivered to its owner (the orchestrator) on completion (§ITEM 8). Carries the
// FULL result so the owner sees everything WITHOUT calling the status tool; the
// status (passed|failed) rides in the header line.

import { safeStringify } from "../../infra/src/util/json.ts";
import type { WorkflowRunResult } from "../../core/src/ports/WorkflowEngine.ts";

export function renderWorkflowCompletion(result: WorkflowRunResult): string {
  return `[workflow ${result.runId}] completed (status: ${result.status}):\n${safeStringify(result.output)}`;
}
