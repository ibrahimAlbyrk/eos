import { z } from "zod";
import type { McpToolModule } from "../tool-registry.ts";
import { safeText } from "../../shared/mcp-tool.ts";

export const messageWorkerTool: McpToolModule = {
  name: "message_worker",
  register(server, session): void {
    server.registerTool(
      "message_worker",
      {
        inputSchema: {
          id: z.string().describe("Worker id, e.g. 'w-abcd1234'"),
          text: z.string().describe(
            "The follow-up directive. Treat this like a fresh worker prompt — be specific. The worker has its prior context but you should still state the new ask clearly.",
          ),
        },
      },
      async ({ id, text }) =>
        safeText(async () => {
          return await session.api("POST", `/workers/${id}/message`, { text, fromParent: session.selfId });
        }),
    );
  },
};
