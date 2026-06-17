import { z } from "zod";
import type { ToolDefinition } from "../types.ts";

export const sendMessageToParentDef: ToolDefinition = {
  name: "send_message_to_parent",
  visibility: "worker",
  inputSchema: {
    text: z.string().describe(
      "The report text. First line MUST be `result: ...`, `needs input: ...`, or `failed: ...`. Subsequent lines: what you did, verification, artifacts, out-of-scope notes.",
    ),
  },
  handler: async (ctx, args) => {
    const { text } = args as { text: string };
    await ctx.api("POST", `/workers/${ctx.selfId}/report`, { text });
    return "Message delivered to orchestrator.";
  },
};
