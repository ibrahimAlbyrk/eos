import { z } from "zod";
import type { McpToolModule } from "../tool-registry.ts";
import { safeText } from "../../shared/mcp-tool.ts";

export const killWorkerTool: McpToolModule = {
  name: "kill_worker",
  register(server, session): void {
    server.registerTool(
      "kill_worker",
      {
        inputSchema: { id: z.string().describe("Worker id, e.g. 'w-abcd1234'") },
      },
      async ({ id }) => safeText(async () => session.api("DELETE", `/workers/${id}?actorId=${session.selfId}`)),
    );
  },
};
