import type { McpToolModule } from "../tool-registry.ts";
import { safeText } from "../tool-registry.ts";

export const listWorkersTool: McpToolModule = {
  name: "list_workers",
  register(server, session): void {
    server.registerTool(
      "list_workers",
      {
        description:
          "List all workers managed by Eos (active and completed), most recent first, up to 30 entries.\n\nWhen to use: the user asks 'what's running?' or 'show me workers', or you need to find a worker by name when you don't have the id.\n\nWhen NOT to use: as a polling mechanism after spawning. The dashboard already shows worker state to the user; repeated calls waste context with no new information.\n\nReturns: array of { id, state, branch, started_at, ended_at, prompt (first 100 chars) }. State is one of: spawning, running, idle, completed, failed, killed.",
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
