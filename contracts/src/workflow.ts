// Workflow contracts — the SSOT for the workflow-orchestration system's stored
// shapes and IPC payloads. The definition (with its standing expert pool + root
// node tree), the persisted run/step rows, the single MCP `workflow` tool's
// request surface, the typed step-output body, and the runtime-store records.
// Mirrors worker-definition.ts (definition catalog) + loop.ts (lifecycle entity).

import { z } from "zod";
import { EFFORT_LEVELS } from "./shared.ts";
import { WorkflowNodeSchema } from "./workflow-node.ts";

// ---- experts — the standing specialist pool (§4) ----------------------------
// Spawned once at run start (persistent + collaborate), kept IDLE-but-consultable
// so step-workers consult them by name via the peer mesh, torn down at run end.
// `id` is the stable handle that becomes the expert's peer-name slug.
export const ExpertSpecSchema = z.object({
  id: z.string(),
  from: z.string().optional(),                 // worker-def: "solid-expert" | "patterns-expert" | …
  prompt: z.string(),                          // standing directive: domain + "stay IDLE-but-consultable"
  model: z.string().optional(),
  effort: z.enum(EFFORT_LEVELS).optional(),
});
export type ExpertSpec = z.infer<typeof ExpertSpecSchema>;

// ---- the workflow definition (§4.4) -----------------------------------------
// description/experts are `.optional()` rather than §4.4's `.default()`: this
// shape is a CommandDef.data (workflow.run / workflow.create), whose `z.ZodType`
// slot demands input===output — a `.default()` diverges the two and is rejected
// (the spawn-worker command schema is default-free for the same reason). Absent
// ⇒ "" / [] is applied where the definition is consumed.
export const WorkflowDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  argsSchema: z.unknown().optional(),          // JSON-Schema for the run args (opaque here)
  experts: z.array(ExpertSpecSchema).optional(),  // ← the standing pool; absent ⇒ none
  root: WorkflowNodeSchema,
});
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

// ---- provenance — clone of WORKER_DEFINITION_SOURCES ------------------------
export const WORKFLOW_DEFINITION_SOURCES = ["builtin", "user", "project", "runtime"] as const;
export const WorkflowDefinitionSourceSchema = z.enum(WORKFLOW_DEFINITION_SOURCES);
export type WorkflowDefinitionSource = z.infer<typeof WorkflowDefinitionSourceSchema>;

// What a definition source.list() yields: the definition + where it came from.
export const WorkflowDefinitionRecordSchema = WorkflowDefinitionSchema.extend({
  source: WorkflowDefinitionSourceSchema,
});
export type WorkflowDefinitionRecord = z.infer<typeof WorkflowDefinitionRecordSchema>;

// ---- run / step lifecycle status enums --------------------------------------
// A run is non-terminal in pending/running (the boot re-arm reconciles these);
// it settles into passed/failed/stopped.
export const WORKFLOW_RUN_STATUSES = ["pending", "running", "passed", "failed", "stopped"] as const;
export const WorkflowRunStatusSchema = z.enum(WORKFLOW_RUN_STATUSES);
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatusSchema>;

// A step row's status doubles as the resume cursor + memoization journal: a
// `passed` step replays its journaled output instead of re-spawning (§3.4).
export const STEP_STATUSES = ["pending", "running", "passed", "failed", "skipped"] as const;
export const StepStatusSchema = z.enum(STEP_STATUSES);
export type StepStatus = z.infer<typeof StepStatusSchema>;

// ---- persisted rows (clone the LoopRow entity shape) ------------------------
// Camel-cased, carrying PARSED args/result/output (the SQLite adapter does the
// *_json round-trip at its edge — §3.7), mirroring how LoopRow carries a parsed
// GoalSpec rather than raw JSON.

export const WorkflowRunSchema = z.object({
  id: z.string(),
  definitionName: z.string().nullable(),       // null for an inline (run-inline) spec
  owner: z.string(),
  anchorId: z.string(),                         // synthetic run-anchor worker row (§3.5)
  status: WorkflowRunStatusSchema,
  args: z.unknown().optional(),
  result: z.unknown().optional(),
  startedAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;

export const WorkflowStepSchema = z.object({
  id: z.string(),
  runId: z.string(),
  nodeId: z.string(),
  nodeType: z.string(),
  status: StepStatusSchema,
  workerId: z.string().nullable(),              // the spawned step-worker (null until/if spawned)
  output: z.unknown().optional(),               // the typed/text result, persisted on report (§3.7)
  startedAt: z.number().int(),
  endedAt: z.number().int().nullable(),
});
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;

// ---- the single MCP `workflow` tool surface (§3.10) -------------------------
// One discriminated-union input (mirrors spawn_worker's `from`). run-stored runs
// a catalogued definition; run-inline runs an emitted spec; create persists a
// spec for reuse; status/stop address a run by id.
export const WorkflowToolRequestSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("run-stored"), from: z.string(), args: z.unknown().optional() }),
  z.object({ mode: z.literal("run-inline"), spec: WorkflowDefinitionSchema, args: z.unknown().optional() }),
  z.object({ mode: z.literal("create"), spec: WorkflowDefinitionSchema }),
  z.object({ mode: z.literal("status"), runId: z.string() }),
  z.object({ mode: z.literal("stop"), runId: z.string() }),
]);
export type WorkflowToolRequest = z.infer<typeof WorkflowToolRequestSchema>;

// The run/status/stop result the tool returns — the lean run view (the full row
// is fetched via GET workflowRun(id)).
export const RunWorkflowResultSchema = z.object({
  runId: z.string(),
  status: WorkflowRunStatusSchema,
  output: z.unknown().optional(),
});
export type RunWorkflowResult = z.infer<typeof RunWorkflowResultSchema>;

// create / create_workflow persists a definition and echoes its name (mirrors
// CreateWorkerResponse).
export const CreateWorkflowResponseSchema = z.object({ name: z.string() });
export type CreateWorkflowResponse = z.infer<typeof CreateWorkflowResponseSchema>;

// GET /workflows — the catalog of runs for the owner.
export const WorkflowRunListResponseSchema = z.array(WorkflowRunSchema);

// ---- typed step I/O — submit_step_output body (§3.6) ------------------------
// The one net-new IPC path. The worker posts its typed result; the route
// validates this envelope, resolves the step's PendingJoin with `output`, and
// persists workflow_steps.output durably in the same handler. The per-step Zod
// validation (against the node's outputSchema) happens engine-side after.
export const StepResultRequestSchema = z.object({
  output: z.unknown(),
});
export type StepResultRequest = z.infer<typeof StepResultRequestSchema>;

export const StepResultResponseSchema = z.object({ ok: z.literal(true) });
export type StepResultResponse = z.infer<typeof StepResultResponseSchema>;
