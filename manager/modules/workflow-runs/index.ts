// Workflow runs (Claude Code's Workflow tool, focused sessions): their live
// progress for the run card and its side-panel tab, and the run record's
// phases and agents (routes under /workers/:id/workflow-runs).

import type { DaemonModule } from "../types.ts";
import type { AgentEvent } from "../../../contracts/src/canonical.ts";
import { WorkflowRunService, type WorkflowRunServiceDeps } from "./WorkflowRunService.ts";
import { registerWorkflowRunRoutes } from "./routes.ts";

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
    workflowRuns,
    onAgentEvent: (workerId: string, event: AgentEvent) => {
      if (event.type === "workflow_started" || event.type === "workflow_completed") workflowRuns.observe(workerId, event);
    },
    registerRoutes: (router) => registerWorkflowRunRoutes(router, { workflowRuns, uiToken: deps.uiToken }),
  };
}
