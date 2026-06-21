import { z } from "zod";
import type { ToolDefinition } from "../types.ts";

export const messageWorkerDef: ToolDefinition = {
  name: "message_worker",
  visibility: "orchestrator",
  inputSchema: {
    id: z.string().describe("Worker id, e.g. 'w-abcd1234'"),
    text: z.string().describe(
      "The follow-up directive — becomes a new user-turn for the worker. State the new ask clearly and in full.",
    ),
  },
  handler: async (ctx, args) => {
    const { id, text } = args as { id: string; text: string };
    return ctx.api("POST", `/workers/${id}/message`, { text, fromParent: ctx.selfId });
  },
};
