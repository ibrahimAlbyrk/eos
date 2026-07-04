import type { ToolDefinition } from "../types.ts";

export const listPendingPermissionsDef: ToolDefinition = {
  name: "list_pending_permissions",
  visibility: "orchestrator",
  inputSchema: {},
  handler: async (ctx) => {
    const rows = (await ctx.api("GET", `/pending?parentId=${ctx.selfId}`)) as Array<Record<string, unknown>>;
    return rows.map((p) => ({
      id: p.id, worker_id: p.worker_id, tool_name: p.tool_name,
      input: p.input, expires_at: p.expires_at,
    }));
  },
};
