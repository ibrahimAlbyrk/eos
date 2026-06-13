import { z } from "zod";
import type { McpToolModule } from "../tool-registry.ts";
import { safeText } from "../../shared/mcp-tool.ts";

export const sendMessageToParentTool: McpToolModule = {
  name: "send_message_to_parent",
  register(server, session): void {
    server.registerTool(
      "send_message_to_parent",
      {
        inputSchema: {
          text: z.string().describe(
            "The report text. First line MUST be `result: ...`, `needs input: ...`, or `failed: ...`. Subsequent lines: what you did, verification, artifacts, out-of-scope notes.",
          ),
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
