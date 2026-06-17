import { z } from "zod";
import type { ToolDefinition } from "../types.ts";
import { commandRequest } from "../../../contracts/src/commands/types.ts";
import { killWorkerCommand } from "../../../contracts/src/commands/defs.ts";

export const killWorkerDef: ToolDefinition = {
  name: "kill_worker",
  visibility: "orchestrator",
  inputSchema: { id: z.string().describe("Worker id, e.g. 'w-abcd1234'") },
  handler: async (ctx, args) => {
    const { id } = args as { id: string };
    const req = commandRequest(killWorkerCommand, { id, actorId: ctx.selfId }, {});
    return ctx.api(req.method, req.path, req.body);
  },
};
