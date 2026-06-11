import type { McpToolModule } from "../tool-registry.ts";
import { safeText } from "../tool-registry.ts";

export const listPendingPermissionsTool: McpToolModule = {
  name: "list_pending_permissions",
  register(server, session): void {
    server.registerTool(
      "list_pending_permissions",
      {
        description:
          "List permission requests from your workers currently waiting for human approval — tool calls that hit a policy 'ask' rule.\n\nWhen to use:\n- The user told you a worker is stuck or quiet and you suspect a permission ask.\n- You want to surface pending decisions to the user proactively (e.g., before spawning more workers).\n\nAn empty list is itself useful — it means none of your workers are blocked on permissions.\n\nReturns: array of { worker_id, tool, input, requested_at }. The user can approve or deny via the dashboard; alternatively the user can tell you to approve via a policy rule.",
        inputSchema: {},
      },
      async () => safeText(async () => session.api("GET", `/pending?parentId=${session.selfId}`)),
    );
  },
};
