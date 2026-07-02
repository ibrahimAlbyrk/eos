// renderWorkflowCompletion — format a finished workflow run as the message body
// delivered to its owner (the orchestrator) on completion (§ITEM 8). Carries the
// FULL result so the owner sees everything WITHOUT calling the status tool. The
// run id + status ride as <system_message kind="worker_report" from="workflow"
// worker-id=… status=…> attributes (applied at the dispatch chokepoint from the
// envelope), so the body is just the clean serialized output.

import { safeStringify } from "../../infra/src/util/json.ts";
import type { WorkflowRunResult } from "../../core/src/ports/WorkflowEngine.ts";
import type { Logger } from "../../core/src/ports/Logger.ts";

export function renderWorkflowCompletion(result: WorkflowRunResult): string {
  return safeStringify(result.output);
}

// The run-completion delivery decision (design A6.4). A run may be AGENT-owned (the
// orchestrator launched it via the MCP `workflow` tool — `owner` is that agent's
// selfId) or OPERATOR-owned (the operator launched it via the CLI / an owner-less
// HTTP POST — no agent row stands behind the owner).
//
// Only an agent owner has an inbox: its completion is dispatched there so the
// orchestrator sees the result without polling. An operator-owned run has nowhere
// to push — its result is read back via GET /workflows/:id + the SSE relay — so the
// inbox dispatch is SKIPPED rather than no-op'd against a missing agent. "Is the
// owner a live agent?" is the sole discriminator, so a removed agent owner (its row
// gone by completion time) also falls through to the read-back path.
export interface WorkflowCompletionDeps {
  isAgentOwner(ownerId: string): boolean;
  deliverToInbox(ownerId: string, result: WorkflowRunResult): void;
  log: Logger;
}

export function makeWorkflowCompletionDelivery(
  deps: WorkflowCompletionDeps,
): (ownerId: string, result: WorkflowRunResult) => void {
  return (ownerId, result) => {
    if (!deps.isAgentOwner(ownerId)) {
      deps.log.debug("workflow completion not delivered to an inbox (operator-owned run)", {
        runId: result.runId, ownerId, status: result.status,
      });
      return;
    }
    deps.deliverToInbox(ownerId, result);
  };
}
