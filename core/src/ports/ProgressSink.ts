// ProgressSink — the Observer seam (§3.11). The engine reports run/step lifecycle
// transitions through this port, staying ignorant of the EventBus; the manager
// adapter (EventBusProgressSink) publishes "workflow:run-change" /
// "workflow:step-change", which SseBroadcaster relays to clients (the loop:change
// model). Keeping it a port means the pure engine never imports the bus.

import type { WorkflowRunStatus, StepStatus } from "../../../contracts/src/workflow.ts";

export interface ProgressSink {
  runChanged(runId: string, status: WorkflowRunStatus): void;
  stepChanged(runId: string, nodeId: string, status: StepStatus, workerId?: string): void;
}
