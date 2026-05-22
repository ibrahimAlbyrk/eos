import type { McpToolModule } from "../tool-registry.ts";
import { safeText } from "../tool-registry.ts";

export const listPendingPermissionsTool: McpToolModule = {
  name: "list_pending_permissions",
  register(server, session): void {
    server.registerTool(
      "list_pending_permissions",
      {
        description:
          "List pending permission requests waiting for human approval (from worker tool calls that hit policy 'ask' rules).",
        inputSchema: {},
      },
      async () => safeText(async () => session.api("GET", "/pending")),
    );
  },
};
