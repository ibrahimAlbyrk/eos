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

import { z } from "zod";
import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";
import { WorkflowToolRequestSchema, WorkflowRunsScopeSchema } from "../../contracts/src/workflow.ts";
import { AnyWorkflowDefinitionSchema } from "../../contracts/src/workflow-graph.ts";

// The history strip is capped server-side — "see recent runs", not a full export.
const RECENT_RUNS_LIMIT = 50;

// The synthetic owner for an operator-launched run (A6.4): the CLI / an owner-less
// HTTP POST has no agent behind it. The run executes fine for any owner; the
// completion is read back via GET /workflows/:id + SSE (deliverCompletion skips a
// non-agent owner — see makeWorkflowCompletionDelivery), never pushed to an inbox.
const OPERATOR_OWNER = "operator";

// Operator-capable run-inline: the orchestrator MCP path emits v1 trees; the
// operator CLI may ALSO POST a v2 node graph. Accept both — a strict widening, the
// v1 tree still validates. (The contract's WorkflowToolRequestSchema stays v1-only
// to keep the orchestrator surface unchanged; graphs enter only through this route.)
const RunInlineRequestSchema = z.object({
  mode: z.literal("run-inline"),
  spec: AnyWorkflowDefinitionSchema,
  args: z.unknown().optional(),
  cwd: z.string().optional(),
});

// owner rides the query (the create_worker precedent); absent ⇒ the operator owner.
function ownerOf(url: URL): string {
  return url.searchParams.get("owner") || OPERATOR_OWNER;
}

export function registerWorkflowRoutes(r: Router, c: Container): void {
  // workflow.run — one discriminated-union body; branch on `mode`. `owner` is
  // OPTIONAL: an agent-launched run rides its selfId in the query; an operator run
  // (CLI / owner-less POST) defaults to the synthetic operator owner (A6.4).
  r.post("/workflows", async ({ url, req, res }) => {
    const owner = ownerOf(url);
    const raw = await readBody(req);
    const mode = (raw as { mode?: unknown }).mode;
    // Starting a run is gated by the subsystem flag; status/stop stay reachable
    // so existing runs can be inspected/aborted even when disabled.
    if ((mode === "run-stored" || mode === "run-inline") && !c.config.workflow.enabled) {
      writeJson(res, 400, { error: "workflow engine is disabled — set config.workflow.enabled" });
      return;
    }
    // run-inline is validated against the operator-capable schema (v1 tree OR v2
    // graph); every other mode against the canonical v1 request union.
    if (mode === "run-inline") {
      const body = validate(RunInlineRequestSchema, raw);
      writeJson(res, 200, c.workflowService.run({ spec: body.spec, args: body.args, cwd: body.cwd }, owner));
      return;
    }
    const body = validate(WorkflowToolRequestSchema, raw);
    switch (body.mode) {
      case "run-stored":
        writeJson(res, 200, c.workflowService.run({ from: body.from, args: body.args, cwd: body.cwd }, owner));
        return;
      case "status":
        writeJson(res, 200, c.workflowService.status(body.runId));
        return;
      case "stop":
        writeJson(res, 200, c.workflowService.stop(body.runId));
        return;
      default:
        // `create` is the idempotent upsert — served by PUT, not POST. (run-inline
        // is handled above, so it never reaches this switch.)
        writeJson(res, 400, { error: "use PUT /workflows to create a definition" });
        return;
    }
  });

  // workflow.create — persist a definition for reuse (owner+name UPSERT). Accepts
  // a v1 tree (the orchestrator path) OR a v2 node graph (the editor SAVE path,
  // A6.2). The editor has no agent behind it, so it rides the synthetic operator
  // owner — same owner-optional rule as the run path; an agent caller still rides
  // its selfId in the query.
  r.put("/workflows", async ({ url, req, res }) => {
    const owner = ownerOf(url);
    const spec = validate(AnyWorkflowDefinitionSchema, await readBody(req));
    writeJson(res, 200, c.workflowService.create(spec, owner));
  });

  // Node-kind palette catalog for the editor (A6.2): the graph node-kinds with
  // their default typed port shapes + the live transform-fn names. A literal
  // path registered BEFORE the /workflows/:id regex (which would otherwise
  // swallow "catalog" as an :id). Open read — no run state, no owner.
  r.get("/workflows/catalog", ({ res }) => {
    writeJson(res, 200, c.workflowNodeCatalog);
  });

  // Merged definition records (builtin + file + runtime/SQLite) for the Library +
  // the editor's from/subGraph selectors — the existing list/CLI omits runtime
  // saves; this closes that gap. Owner rides the query (operator default), same as
  // PUT/DELETE; each record carries its `source` provenance. Literal path
  // registered BEFORE the /workflows/:id regex (else "definitions" reads as an :id).
  r.get("/workflows/definitions", ({ url, res }) => {
    writeJson(res, 200, c.listWorkflowDefinitions(ownerOf(url)));
  });

  // Run list for the observation view: ?scope=active (in-flight, cross-owner) |
  // recent (capped most-recent history). Read-only; both are thin repo reads.
  // Literal path registered BEFORE the /workflows/:id regex.
  r.get("/workflows/runs", ({ url, res }) => {
    const scope = WorkflowRunsScopeSchema.catch("active").parse(url.searchParams.get("scope") ?? "active");
    writeJson(res, 200, scope === "recent" ? c.workflowRuns.listRecent(RECENT_RUNS_LIMIT) : c.workflowRuns.listActive());
  });

  // Per-node step rows for one run (the read-only run canvas / step list +
  // per-node coloring backfill on mount). Two-segment path — no collision with
  // the single-segment /workflows/:id regex.
  r.get(/^\/workflows\/(?<id>[^/]+)\/steps$/, ({ params, res }) => {
    writeJson(res, 200, c.workflowSteps.listByRun(params.id));
  });

  // The dashboard status read — the full persisted run row (404 when unknown).
  r.get(/^\/workflows\/(?<id>[^/]+)$/, ({ params, res }) => {
    const row = c.workflowRuns.findById(params.id);
    if (!row) { writeJson(res, 404, { error: "workflow run not found" }); return; }
    writeJson(res, 200, row);
  });

  // workflow.delete — remove a stored (runtime) definition by name; the symmetric
  // mirror of PUT (create). Owner rides the query (operator default), same as
  // create. A builtin name is rejected (ValidationError→400) and an unknown name
  // 404s (NotFoundError) via the central error handler.
  r.del(/^\/workflows\/(?<name>[^/]+)$/, ({ url, params, res }) => {
    const owner = ownerOf(url);
    writeJson(res, 200, c.workflowService.deleteDefinition(decodeURIComponent(params.name), owner));
  });
}
