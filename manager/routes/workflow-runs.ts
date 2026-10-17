// Claude Code Workflow runs (contracts/src/workflow-run.ts, plan
// docs/workflow-runs/00-WORKFLOW-RUNS-PLAN.md):
//   GET  /workers/:id/workflow-runs                         the worker's running runs
//   GET  /workers/:id/workflow-runs/:callId                 one run, live or finished
//   GET  /workers/:id/workflow-runs/:callId/agents/:agentId one agent's transcript rows
//   POST /workers/:id/workflow-runs/:callId/stop            the dashboard's (ui-token)

import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { uiTokenOk } from "./fs-shared.ts";
import type { WorkflowAgentRows, WorkflowRunList } from "../../contracts/src/workflow-run.ts";

const RUNS = /^\/workers\/(?<id>[^/]+)\/workflow-runs$/;
const RUN = /^\/workers\/(?<id>[^/]+)\/workflow-runs\/(?<callId>[A-Za-z0-9_-]+)$/;
const STOP = /^\/workers\/(?<id>[^/]+)\/workflow-runs\/(?<callId>[A-Za-z0-9_-]+)\/stop$/;
const AGENT = /^\/workers\/(?<id>[^/]+)\/workflow-runs\/(?<callId>[A-Za-z0-9_-]+)\/agents\/(?<agentId>[^/]+)$/;

export function registerWorkflowRunRoutes(r: Router, c: Container): void {
  r.get(RUNS, ({ res, params }) => {
    const body: WorkflowRunList = { runs: c.workflowRuns.list(params.id) };
    writeJson(res, 200, body);
  });

  r.get(RUN, ({ res, params }) => {
    const run = c.workflowRuns.get(params.id, params.callId);
    if (!run) { writeJson(res, 404, { error: "no workflow run with that call id" }); return; }
    writeJson(res, 200, run);
  });

  r.get(AGENT, ({ res, params }) => {
    const rows = c.workflowRuns.agentRows(params.id, params.callId, params.agentId);
    if (!rows) { writeJson(res, 404, { error: "no transcript for that agent" }); return; }
    const body: WorkflowAgentRows = { rows };
    writeJson(res, 200, body);
  });

  r.post(STOP, async ({ req, res, params }) => {
    if (!uiTokenOk(req, c.uiToken)) { writeJson(res, 403, { error: "ui token required" }); return; }
    const result = await c.workflowRuns.stop(params.id, params.callId);
    if (result.ok) writeJson(res, 200, { ok: true });
    else writeJson(res, result.status, { error: result.error });
  });
}
