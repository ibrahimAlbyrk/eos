import type { ToolDefinition } from "../types.ts";

export const listActiveWorkersDef: ToolDefinition = {
  name: "list_active_workers",
  visibility: "orchestrator",
  inputSchema: {},
  handler: async (ctx) => {
    const rows = (await ctx.api("GET", `/workers?parentId=${ctx.selfId}`)) as Array<Record<string, unknown>>;
    return rows.slice(0, 30).map((w) => ({
      id: w.id, name: w.name ?? null, state: w.state, branch: w.branch ?? null,
      worker_definition: w.worker_definition ?? null,
      started_at: w.started_at, ended_at: w.ended_at,
      prompt: String(w.prompt ?? "").slice(0, 100),
    }));
  },
};
