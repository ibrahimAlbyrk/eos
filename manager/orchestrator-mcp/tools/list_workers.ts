import type { McpToolModule } from "../tool-registry.ts";
import { safeText } from "../tool-registry.ts";

export const listWorkersTool: McpToolModule = {
  name: "list_workers",
  register(server, session): void {
    server.registerTool(
      "list_workers",
      {
        description:
          "List all workers managed by claude-manager (active and completed). Returns id, state, branch, duration, prompt summary.",
        inputSchema: {},
      },
      async () =>
        safeText(async () => {
          const rows = (await session.api("GET", "/workers")) as Array<Record<string, unknown>>;
          return rows.slice(0, 30).map((w) => ({
            id: w.id, state: w.state, branch: w.branch ?? null,
            started_at: w.started_at, ended_at: w.ended_at,
            prompt: String(w.prompt ?? "").slice(0, 100),
          }));
        }),
    );
  },
};
