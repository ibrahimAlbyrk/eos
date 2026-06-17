import type { ToolDefinition } from "../types.ts";

export const listPendingPermissionsDef: ToolDefinition = {
  name: "list_pending_permissions",
  visibility: "orchestrator",
  inputSchema: {},
  handler: async (ctx) => ctx.api("GET", `/pending?parentId=${ctx.selfId}`),
};
