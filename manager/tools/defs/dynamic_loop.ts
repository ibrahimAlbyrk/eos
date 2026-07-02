import { z } from "zod";
import type { ToolDefinition } from "../types.ts";
import type { DynamicLoopRequest } from "../../../contracts/src/loop.ts";

// The goal shape is re-declared with the manager-local zod here (the MCP-facing
// inputSchema each lane builds itself); the route validates the posted body
// against the canonical GoalSpecSchema in contracts/src/loop.ts.
export const dynamicLoopDef: ToolDefinition = {
  name: "dynamic_loop",
  visibility: "orchestrator",
  inputSchema: {
    op: z.enum(["attach", "amend", "stop"]).describe(
      "'attach' to arm a loop, 'amend' to renegotiate an active loop's goal/strategy/limit in place, 'stop' to end one.",
    ),
    target: z.string().optional().describe(
      "Worker id to loop. Omit (or pass your own id) to loop yourself.",
    ),
    goal: z
      .object({
        summary: z.string().describe("One-line headline of what 'done' means."),
        criteria: z
          .array(
            z.object({
              id: z.string().describe("Stable short id for this criterion."),
              text: z.string().describe("The checkable condition in plain language."),
              verify: z.string().optional().describe("Deterministic shell command that proves it, if any."),
            }),
          )
          .min(1),
      })
      .optional()
      .describe("The structured goal (required for 'attach'; for 'amend' the replacement goal — omit to keep the current one)."),
    strategy: z.enum(["command", "judge", "hybrid"]).optional().describe(
      "How the goal is checked. Defaults to 'hybrid' on attach; on 'amend' omit to keep the current strategy.",
    ),
    limit: z.number().int().positive().nullable().optional().describe(
      "Max attempts before the loop exhausts. null = unbounded (goal-met is the only exit). On 'amend' omit to keep the current limit.",
    ),
    loopId: z.string().optional().describe("The loop to amend/stop; omit to target the worker's active loop (via `target`)."),
  },
  handler: async (ctx, args) => {
    const a = args as DynamicLoopRequest;
    const path = a.op === "stop"
      ? `/orchestrators/${ctx.selfId}/loop/stop`
      : `/orchestrators/${ctx.selfId}/loop`;
    return ctx.api("POST", path, a);
  },
};
