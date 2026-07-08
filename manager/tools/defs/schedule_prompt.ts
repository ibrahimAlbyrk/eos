import { z } from "zod";
import type { ToolDefinition } from "../types.ts";
import { ROUTES } from "../../../contracts/src/http.ts";
import type { CurrentDateTimeResponse } from "../../../contracts/src/http.ts";

// Schedule a prompt to fire into your OWN chat at a future instant. Exactly one
// of fireAtEpochMs / delayMinutes is required. delayMinutes is resolved against
// the daemon's authoritative clock (GET /datetime) so the fire time never
// depends on this process's local clock.
export const schedulePromptDef: ToolDefinition = {
  name: "schedule_prompt",
  visibility: "orchestrator",
  inputSchema: {
    text: z.string().describe("The prompt text to deliver into your chat when it fires."),
    fireAtEpochMs: z.number().int().positive().optional().describe(
      "Absolute fire time as a UTC epoch-milliseconds instant. Provide this OR delayMinutes, not both.",
    ),
    delayMinutes: z.number().positive().optional().describe(
      "Fire this many minutes from now. Provide this OR fireAtEpochMs, not both.",
    ),
  },
  handler: async (ctx, args) => {
    const { text, fireAtEpochMs, delayMinutes } = args as {
      text: string;
      fireAtEpochMs?: number;
      delayMinutes?: number;
    };
    const hasEpoch = typeof fireAtEpochMs === "number";
    const hasDelay = typeof delayMinutes === "number";
    if (hasEpoch === hasDelay) {
      return "Provide exactly one of fireAtEpochMs or delayMinutes.";
    }
    let fireAt: number;
    if (hasEpoch) {
      fireAt = fireAtEpochMs!;
    } else {
      const now = (await ctx.api("GET", ROUTES.datetime)) as CurrentDateTimeResponse;
      fireAt = now.epochMs + delayMinutes! * 60_000;
    }
    return ctx.api("POST", ROUTES.scheduledPrompts, { workerId: ctx.selfId, text, fireAt });
  },
};
