import { z } from "zod";
import type { McpToolModule } from "../tool-registry.ts";
import { safeText } from "../tool-registry.ts";

export const sendMessageToParentTool: McpToolModule = {
  name: "send_message_to_parent",
  register(server, session): void {
    server.registerTool(
      "send_message_to_parent",
      {
        description:
          "Send a message to your parent orchestrator. Use this to report findings, deliver results, ask clarifying questions, or send progress updates. The orchestrator will receive your message and may reply with follow-up instructions.",
        inputSchema: {
          text: z.string().describe("The message to send to the orchestrator."),
        },
      },
      async ({ text }) =>
        safeText(async () => {
          await session.api("POST", `/workers/${session.selfId}/report`, { text });
          return "Message delivered to orchestrator.";
        }),
    );
  },
};
