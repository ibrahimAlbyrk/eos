import { z } from "zod";
import type { ToolDefinition } from "../types.ts";
import { normalizeEventRows } from "../../../core/src/domain/message-normalize.ts";
import type { WorkerEventRow } from "../../../contracts/src/events.ts";

export const getWorkerMessagesDef: ToolDefinition = {
  name: "get_worker_messages",
  visibility: "orchestrator",
  inputSchema: {
    id: z.string().describe("Worker id, e.g. 'w-abcd1234'"),
    n: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(5)
      .describe("How many of the worker's most recent messages to return (5 = last five, 1 = just the latest)."),
  },
  handler: async (ctx, args) => {
    const { id, n } = args as { id: string; n: number };
    // Non-message rows (tool calls, usage, heartbeats) are interleaved with the
    // conversation, so N rows are never N messages — over-fetch a generous window
    // and let normalizeEventRows keep the newest n messages.
    const batch = Math.min(n * 8, 200);
    const rows = await ctx.api("GET", `/workers/${id}/events?limit=${batch}&order=desc`);
    return { messages: normalizeEventRows(rows as WorkerEventRow[], n) };
  },
};
