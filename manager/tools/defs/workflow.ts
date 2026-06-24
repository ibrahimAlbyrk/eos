import { z } from "zod";
import type { ToolDefinition } from "../types.ts";
import { commandRequest } from "../../../contracts/src/commands/types.ts";
import { runWorkflowCommand, createWorkflowCommand } from "../../../contracts/src/commands/defs.ts";
import type { WorkflowToolRequest } from "../../../contracts/src/workflow.ts";
import type { WorkflowDefinition } from "../../../contracts/src/workflow.ts";

// The claude-sdk lane sometimes serializes a nested object input (spec/args) as a
// JSON STRING because their tool inputSchema slot is `z.unknown()`. The route
// validates `spec`/`args` as OBJECTS, so a string yields a 400. Coerce here: parse
// strings, pass objects through, leave undefined alone. A non-JSON string is a
// caller error surfaced clearly rather than forwarded to the daemon.
function coerceJson(value: unknown, field: "spec" | "args"): unknown {
  if (value === undefined || typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`workflow ${field} must be a JSON object or a valid JSON string`);
  }
}

// The single orchestrator-visibility tool for the deterministic workflow engine
// (§3.10). One flat input projects the WorkflowToolRequest discriminated union;
// the route validates the posted body against the canonical schema. `create` is
// the idempotent PUT upsert; every other mode posts the union body to POST
// /workflows. The owner (this orchestrator's selfId) rides the `owner` query so
// the run/definition is scoped to the caller (the create_worker precedent).
export const workflowDef: ToolDefinition = {
  name: "workflow",
  visibility: "orchestrator",
  inputSchema: {
    mode: z.enum(["run-stored", "run-inline", "create", "status", "stop"]).describe(
      "run-stored: run a catalogued definition by `from`. run-inline: run an emitted `spec` once. create: persist a `spec` for reuse. status: read a run by `runId`. stop: abort a run by `runId` (reaps its workers).",
    ),
    from: z.string().optional().describe("Stored workflow definition name (run-stored)."),
    spec: z.unknown().optional().describe(
      "The workflow definition object — { name, root, experts? } (run-inline / create). Validated server-side against the canonical schema.",
    ),
    args: z.unknown().optional().describe("Run arguments object bound as {{args.*}} in step prompts (run-stored / run-inline)."),
    runId: z.string().optional().describe("Target run id (status / stop)."),
  },
  handler: async (ctx, args) => {
    const a = args as { mode: string; from?: string; spec?: unknown; args?: unknown; runId?: string };
    const owner = encodeURIComponent(ctx.selfId);
    const spec = coerceJson(a.spec, "spec");
    const runArgs = coerceJson(a.args, "args");
    let req;
    if (a.mode === "create") {
      req = commandRequest(createWorkflowCommand, {}, spec as WorkflowDefinition);
    } else {
      const body: Record<string, unknown> = { ...a };
      if (spec !== undefined) body.spec = spec;
      if (runArgs !== undefined) body.args = runArgs;
      req = commandRequest(runWorkflowCommand, {}, body as unknown as WorkflowToolRequest);
    }
    return ctx.api(req.method, `${req.path}?owner=${owner}`, req.body);
  },
};
