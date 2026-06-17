import { z } from "zod";
import type { ToolDefinition } from "../types.ts";

export const getWorkerDef: ToolDefinition = {
  name: "get_worker",
  visibility: "orchestrator",
  inputSchema: { id: z.string().describe("Worker id, e.g. 'w-abcd1234'") },
  handler: async (ctx, args) => {
    const { id } = args as { id: string };
    const worker = await ctx.api("GET", `/workers/${id}?actorId=${ctx.selfId}`);
    const events = await ctx.api("GET", `/workers/${id}/events?limit=30`);
    return { worker, events };
  },
};
