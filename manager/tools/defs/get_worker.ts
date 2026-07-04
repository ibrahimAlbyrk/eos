import { z } from "zod";
import type { ToolDefinition } from "../types.ts";

export const getWorkerDef: ToolDefinition = {
  name: "get_worker",
  visibility: "orchestrator",
  inputSchema: { id: z.string().describe("Worker id, e.g. 'w-abcd1234'") },
  handler: async (ctx, args) => {
    const { id } = args as { id: string };
    const w = (await ctx.api("GET", `/workers/${id}?actorId=${ctx.selfId}`)) as Record<string, unknown>;
    return {
      worker: {
        id: w.id, name: w.name ?? null, state: w.state, branch: w.branch ?? null,
        prompt: w.prompt, started_at: w.started_at, ended_at: w.ended_at ?? null,
        exit_code: w.exit_code ?? null, model: w.model ?? null,
        context: w.context ?? null, loop: w.loop ?? null,
        worker_definition: w.worker_definition ?? null, cost_usd: w.cost_usd ?? null,
        parent_id: w.parent_id ?? null, tasks: w.tasks ?? null,
      },
    };
  },
};
