import { z } from "zod";
import type { ToolDefinition } from "../types.ts";

// workflow_step_output — the SOLE settle channel for a workflow-worker node (Part
// B). The node emits ONE typed output + an explicit status; the daemon's
// /step-output route decides the loop hold and publishes the workflow:step-output
// bus topic the step-join resolves on. Distinct from send_message_to_parent: no
// parent dispatch, no auto-apply, no first-line signal sniff.
export const workflowStepOutputDef: ToolDefinition = {
  name: "workflow_step_output",
  visibility: "worker",
  inputSchema: {
    output: z.unknown().describe(
      "This node's output value — the typed payload other nodes consume. Must match the node's declared output schema if it has one.",
    ),
    status: z.enum(["done", "failed", "needs-input"]).describe(
      "done = the node's work is complete and `output` is the result; failed = could not complete; needs-input = blocked on missing input.",
    ),
    reason: z.string().optional().describe(
      "One-line why, REQUIRED for failed/needs-input. Becomes the node's failure output.",
    ),
  },
  handler: async (ctx, args) => {
    const { output, status, reason } = args as { output: unknown; status: string; reason?: string };
    await ctx.api("POST", `/workers/${ctx.selfId}/step-output`, { output, status, reason });
    return "Node output recorded.";
  },
};
