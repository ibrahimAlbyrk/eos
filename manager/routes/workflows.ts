// Workflow run-control + read surface (§3.10). The single MCP `workflow` tool
// posts here through the unified command catalog's run/create endpoints; this
// module serves them owner-scoped, exactly like the worker-definition catalog —
// the caller (orchestrator selfId) arrives in the `owner` query param (the
// runWorkflowCommand/createWorkflowCommand addr is NoAddr and carries no owner),
// the worker-definitions / create_worker precedent. Streaming is free: the engine
// publishes workflow:run-change / workflow:step-change through the ProgressSink →
// SseBroadcaster relay, so this module only validates → drives the service →
// writes the lean result.
//
//   POST /workflows          run-stored | run-inline | status | stop  (workflow.run)
//   PUT  /workflows          create a (persist) definition            (workflow.create)
//   GET  /workflows/:id      read one run row (the dashboard status read)

import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";
import {
  WorkflowToolRequestSchema, WorkflowDefinitionSchema,
} from "../../contracts/src/workflow.ts";

function requireOwner(url: URL): string | null {
  return url.searchParams.get("owner");
}

export function registerWorkflowRoutes(r: Router, c: Container): void {
  // workflow.run — one discriminated-union body; branch on `mode`.
  r.post("/workflows", async ({ url, req, res }) => {
    const owner = requireOwner(url);
    if (!owner) { writeJson(res, 400, { error: "owner query param required" }); return; }
    const body = validate(WorkflowToolRequestSchema, await readBody(req));
    // Starting a run is gated by the subsystem flag; status/stop stay reachable
    // so existing runs can be inspected/aborted even when disabled.
    if ((body.mode === "run-stored" || body.mode === "run-inline") && !c.config.workflow.enabled) {
      writeJson(res, 400, { error: "workflow engine is disabled — set config.workflow.enabled" });
      return;
    }
    switch (body.mode) {
      case "run-stored":
        writeJson(res, 200, c.workflowService.run({ from: body.from, args: body.args }, owner));
        return;
      case "run-inline":
        writeJson(res, 200, c.workflowService.run({ spec: body.spec, args: body.args }, owner));
        return;
      case "status":
        writeJson(res, 200, c.workflowService.status(body.runId));
        return;
      case "stop":
        writeJson(res, 200, c.workflowService.stop(body.runId));
        return;
      default:
        // `create` is the idempotent upsert — served by PUT, not POST.
        writeJson(res, 400, { error: "use PUT /workflows to create a definition" });
        return;
    }
  });

  // workflow.create — persist a definition for reuse (owner+name UPSERT).
  r.put("/workflows", async ({ url, req, res }) => {
    const owner = requireOwner(url);
    if (!owner) { writeJson(res, 400, { error: "owner query param required" }); return; }
    const spec = validate(WorkflowDefinitionSchema, await readBody(req));
    writeJson(res, 200, c.workflowService.create(spec, owner));
  });

  // The dashboard status read — the full persisted run row (404 when unknown).
  r.get(/^\/workflows\/(?<id>[^/]+)$/, ({ params, res }) => {
    const row = c.workflowRuns.findById(params.id);
    if (!row) { writeJson(res, 404, { error: "workflow run not found" }); return; }
    writeJson(res, 200, row);
  });
}
