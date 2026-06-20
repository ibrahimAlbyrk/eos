import { z } from "zod";
import type { ToolDefinition } from "../types.ts";

export const integrateWorkersDef: ToolDefinition = {
  name: "integrate_workers",
  visibility: "orchestrator",
  inputSchema: {
    ids: z
      .array(z.string())
      .optional()
      .describe("Limit to these worker ids. Omit to integrate ALL of your workers' branches."),
  },
  handler: async (ctx, args) => {
    const { ids } = args as { ids?: string[] };
    return ctx.api("POST", `/orchestrators/${ctx.selfId}/integrate`, ids ? { ids } : {});
  },
};
