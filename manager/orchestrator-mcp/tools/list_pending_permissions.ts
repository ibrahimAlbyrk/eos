import type { McpToolModule } from "../tool-registry.ts";
import { safeText } from "../../shared/mcp-tool.ts";

export const listPendingPermissionsTool: McpToolModule = {
  name: "list_pending_permissions",
  register(server, session): void {
    server.registerTool(
      "list_pending_permissions",
      {
        inputSchema: {},
      },
      async () => safeText(async () => session.api("GET", `/pending?parentId=${session.selfId}`)),
    );
  },
};
