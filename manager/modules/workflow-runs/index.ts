// Workflow runs (Claude Code's Workflow tool, focused sessions): their live
// progress for the run card and its side-panel tab, and the run record's
// phases and agents (routes under /workers/:id/workflow-runs).

import type { DaemonModule } from "../types.ts";
import type { AgentEvent } from "../../../contracts/src/canonical.ts";
import { WorkflowRunService, type WorkflowRunServiceDeps } from "./WorkflowRunService.ts";
import { WORKFLOW_RUN_ROUTE_ACCESS, registerWorkflowRunRoutes } from "./routes.ts";

declare module "../../../core/src/ports/EventBus.ts" {
  interface EventBusTopics {
    // A running Claude Code Workflow's latest snapshot (claude SDK lane; payload
    // WorkflowRunProgress), at most twice a second per run. Ephemeral — the run's
    // start and end are agent events.
    "workflow:progress": true;
  }
}

export interface WorkflowRunsModuleDeps extends WorkflowRunServiceDeps {
  readonly uiToken: string;
}

export interface WorkflowRunsModule extends DaemonModule {
  readonly workflowRuns: WorkflowRunService;
}

export function createWorkflowRunsModule(deps: WorkflowRunsModuleDeps): WorkflowRunsModule {
  const workflowRuns = new WorkflowRunService(deps);
  return {
    id: "workflow-runs",
    routeAccess: WORKFLOW_RUN_ROUTE_ACCESS,
    workflowRuns,
    onAgentEvent: (workerId: string, event: AgentEvent) => {
      if (event.type === "workflow_started" || event.type === "workflow_completed") workflowRuns.observe(workerId, event);
    },
    registerRoutes: (router) => registerWorkflowRunRoutes(router, { workflowRuns, uiToken: deps.uiToken }),
  };
}
