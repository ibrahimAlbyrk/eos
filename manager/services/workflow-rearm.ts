// reArmWorkflows — boot re-arm for the workflow engine (sibling of reArmLoops,
// §3.7). A workflow run is daemon-resident with no external trigger, so after a
// restart each non-terminal run must be re-driven. buildContainer already ran
// ReconcileWorkersOnBoot synchronously, so every in-flight step-worker row is now
// SUSPENDED (resumable) or DONE (+ a worker:exit was emitted). For each active
// run we first recover any UNJOURNALED completion (below), then call engine.resume:
// journaled `passed` steps replay their memoized output without re-spawning; the
// first un-journaled node runs live (entity-row reconciliation, not script replay).
//
// Runs re-arm concurrently (a long run must not block the others or boot). The
// daemon voids the returned promise, so boot proceeds while runs drive in the
// background; a test may await it for determinism. Each run's failure is isolated
// and logged — one wedged run never aborts the re-arm of its siblings.
//
// UNJOURNALED-COMPLETION RECOVERY (§3.7). `worker:report` is an ephemeral bus
// topic, lost on restart, and a reconciled worker that already reported will NOT
// re-report — so a step whose worker finished but whose `passed` journal write was
// lost in the crash window would otherwise be re-spawned, double-running the work
// and wedging the run. We close that seam from TWO durable traces, matched against
// each still-`running` step by its stamped worker id (WorkerSpawnAdapter persists
// it at spawn, before the report can land):
//   (2) the parent-timeline `worker_report` event — DispatchMessage logs it keyed
//       by the anchor row, `payload.fromWorker` = the step worker (`text` = body).
//   (3) the agent-plane `queued_messages` envelope — the report holds here when the
//       synthetic anchor (no live agent) never drains it; durable + idempotent.
// A hit marks the step `passed` with the recovered output, so engine.resume then
// memo-replays it instead of re-spawning. (Source (1), child worker state, is
// already reconciled by ReconcileWorkersOnBoot before this runs.)

import type { WorkflowRunRepo } from "../../core/src/ports/WorkflowRunRepo.ts";
import type { WorkflowStepRepo } from "../../core/src/ports/WorkflowStepRepo.ts";
import type { EventRepo } from "../../core/src/ports/EventRepo.ts";
import type { MessageQueueRepo } from "../../core/src/ports/MessageQueueRepo.ts";
import type { WorkflowRun } from "../../contracts/src/workflow.ts";
import type { Logger } from "../../core/src/ports/Logger.ts";

export interface ReArmWorkflowsDeps {
  runs: Pick<WorkflowRunRepo, "listActive">;
  steps: Pick<WorkflowStepRepo, "listByRun" | "setStatus" | "setOutput">;
  // Durable recovery sources under a run's anchor (§3.7). Narrowed to the single
  // read each one needs; the container wires SqliteEventRepo + the message queue.
  events: Pick<EventRepo, "list">;
  queue: Pick<MessageQueueRepo, "listPending">;
  resume(runId: string): Promise<unknown>;
  log: Logger;
}

const MAX_ANCHOR_EVENTS = 5000;

export async function reArmWorkflows(deps: ReArmWorkflowsDeps): Promise<void> {
  await Promise.all(
    deps.runs.listActive().map(async (run) => {
      try {
        recoverUnjournaledCompletions(deps, run);
        await deps.resume(run.id);
      } catch (e) {
        deps.log.warn("workflow re-arm failed", { runId: run.id, error: e instanceof Error ? e.message : String(e) });
      }
    }),
  );
}

// For each still-`running` step with a stamped worker id, mark it `passed` from a
// durable report trace so resume memo-replays it rather than re-spawning. A step
// with no worker id is a composite (no worker) or never reached spawn — left as-is.
function recoverUnjournaledCompletions(deps: ReArmWorkflowsDeps, run: WorkflowRun): void {
  for (const step of deps.steps.listByRun(run.id)) {
    if (step.status !== "running" || !step.workerId) continue;
    const recovered = recoverReport(deps, run.anchorId, step.workerId);
    if (recovered === undefined) continue;
    deps.steps.setOutput(run.id, step.nodeId, recovered);
    deps.steps.setStatus(run.id, step.nodeId, "passed");
    deps.log.info("workflow re-arm recovered unjournaled step", {
      runId: run.id, nodeId: step.nodeId, workerId: step.workerId,
    });
  }
}

function recoverReport(deps: ReArmWorkflowsDeps, anchorId: string, workerId: string): unknown {
  // (2) parent-timeline worker_report event (payload is the raw JSON string).
  try {
    const rows = deps.events.list({ workerId: anchorId, since: 0, limit: MAX_ANCHOR_EVENTS, order: "asc" });
    for (const row of rows) {
      if (row.type !== "worker_report" || !row.payload) continue;
      const p = JSON.parse(row.payload) as { fromWorker?: unknown; text?: unknown };
      if (p.fromWorker === workerId) return typeof p.text === "string" ? p.text : "";
    }
  } catch (e) {
    deps.log.warn("workflow re-arm event scan failed", { anchorId, error: e instanceof Error ? e.message : String(e) });
  }
  // (3) agent-plane queued envelope — the durable hold for an undelivered report.
  try {
    for (const q of deps.queue.listPending(anchorId)) {
      if (q.envelope?.kind === "worker_report" && q.envelope.fromWorker === workerId) {
        return q.displayText ?? q.text;
      }
    }
  } catch (e) {
    deps.log.warn("workflow re-arm queue scan failed", { anchorId, error: e instanceof Error ? e.message : String(e) });
  }
  return undefined;
}
