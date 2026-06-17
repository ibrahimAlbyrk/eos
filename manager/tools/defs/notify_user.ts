import { z } from "zod";
import type { ToolDefinition } from "../types.ts";

export const notifyUserDef: ToolDefinition = {
  name: "notify_user",
  visibility: "orchestrator",
  inputSchema: {
    title: z.string().describe("Short headline, a few words. E.g. 'Task complete'"),
    body: z.string().describe("One sentence with the concrete outcome. E.g. 'Auth refactor done across 3 workers — review ready.'"),
  },
  handler: async (ctx, args) => {
    const { title, body } = args as { title: string; body: string };
    return ctx.api("POST", `/workers/${ctx.selfId}/notify`, { title, body });
  },
};
