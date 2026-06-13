import type { McpToolModule } from "../tool-registry.ts";
import { safeText } from "../../shared/mcp-tool.ts";

export const listWorkersTool: McpToolModule = {
  name: "list_workers",
  register(server, session): void {
    server.registerTool(
      "list_workers",
      {
        inputSchema: {},
      },
      async () =>
        safeText(async () => {
          const rows = (await session.api("GET", `/workers?parentId=${session.selfId}`)) as Array<Record<string, unknown>>;
          return rows.slice(0, 30).map((w) => ({
            id: w.id, name: w.name ?? null, state: w.state, branch: w.branch ?? null,
            started_at: w.started_at, ended_at: w.ended_at,
            prompt: String(w.prompt ?? "").slice(0, 100),
          }));
        }),
    );
  },
};
