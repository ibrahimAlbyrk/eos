import { z } from "zod";
import type { McpToolModule } from "../tool-registry.ts";
import { safeText } from "../../shared/mcp-tool.ts";

export const getWorkerTool: McpToolModule = {
  name: "get_worker",
  register(server, session): void {
    server.registerTool(
      "get_worker",
      {
        inputSchema: { id: z.string().describe("Worker id, e.g. 'w-abcd1234'") },
      },
      async ({ id }) =>
        safeText(async () => {
          const worker = await session.api("GET", `/workers/${id}?actorId=${session.selfId}`);
          const events = await session.api("GET", `/workers/${id}/events?limit=30`);
          return { worker, events };
        }),
    );
  },
};
