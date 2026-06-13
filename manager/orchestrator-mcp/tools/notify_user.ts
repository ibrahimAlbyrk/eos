import { z } from "zod";
import type { McpToolModule } from "../tool-registry.ts";
import { safeText } from "../../shared/mcp-tool.ts";

export const notifyUserTool: McpToolModule = {
  name: "notify_user",
  register(server, session): void {
    server.registerTool(
      "notify_user",
      {
        inputSchema: {
          title: z.string().describe("Short headline, a few words. E.g. 'Task complete'"),
          body: z.string().describe("One sentence with the concrete outcome. E.g. 'Auth refactor done across 3 workers — review ready.'"),
        },
      },
      async ({ title, body }) =>
        safeText(async () => {
          return await session.api("POST", `/workers/${session.selfId}/notify`, { title, body });
        }),
    );
  },
};
