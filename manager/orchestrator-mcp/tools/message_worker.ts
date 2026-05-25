import { z } from "zod";
import type { McpToolModule } from "../tool-registry.ts";
import { safeText } from "../tool-registry.ts";

export const messageWorkerTool: McpToolModule = {
  name: "message_worker",
  register(server, session): void {
    server.registerTool(
      "message_worker",
      {
        description:
          "Send a follow-up message to a running worker. Use this to give additional instructions, ask for clarification, or request changes after a worker has reported back.",
        inputSchema: {
          id: z.string().describe("Worker id, e.g. 'w-abcd1234'"),
          text: z.string().describe("The message to send to the worker."),
        },
      },
      async ({ id, text }) =>
        safeText(async () => {
          return await session.api("POST", `/workers/${id}/message`, { text, fromParent: session.selfId });
        }),
    );
  },
};
