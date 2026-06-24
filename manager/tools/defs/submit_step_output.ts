import type { ToolDefinition } from "../types.ts";
import { ROUTES } from "../../../contracts/src/http.ts";
import { StepResultRequestSchema, type StepResultRequest } from "../../../contracts/src/workflow.ts";

// The one net-new typed-result IPC path (§3.6): a workflow step-worker returns its
// structured result here instead of as free report text. The route resolves the
// step's PendingJoin with the typed object and persists it durably. The input
// shape is the contracts StepResultRequestSchema, reused (not re-wrapped) to keep
// a single Zod identity across packages.
export const submitStepOutputDef: ToolDefinition = {
  name: "submit_step_output",
  visibility: "worker",
  inputSchema: StepResultRequestSchema.shape,
  handler: async (ctx, args) => {
    const { output } = args as StepResultRequest;
    await ctx.api("POST", ROUTES.workflowStepOutput(ctx.selfId), { output });
    return "Step output recorded.";
  },
};
