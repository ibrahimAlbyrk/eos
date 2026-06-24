// EventBusProgressSink — the manager adapter for the core ProgressSink port
// (§3.11). The engine reports run/step lifecycle transitions through ProgressSink,
// staying ignorant of the EventBus; this adapter publishes them as
// "workflow:run-change" / "workflow:step-change", which SseBroadcaster relays to
// clients via its "*" subscription (the loop:change model). Pure fan-out — no
// state of its own.

import type { EventBus } from "../../core/src/ports/EventBus.ts";
import type { ProgressSink } from "../../core/src/ports/ProgressSink.ts";
import type { WorkflowRunStatus, StepStatus } from "../../contracts/src/workflow.ts";

export class EventBusProgressSink implements ProgressSink {
  private readonly bus: EventBus;

  constructor(bus: EventBus) {
    this.bus = bus;
  }

  runChanged(runId: string, status: WorkflowRunStatus): void {
    this.bus.publish("workflow:run-change", { runId, status });
  }

  stepChanged(runId: string, nodeId: string, status: StepStatus, workerId?: string): void {
    this.bus.publish("workflow:step-change", { runId, nodeId, status, workerId });
  }
}
