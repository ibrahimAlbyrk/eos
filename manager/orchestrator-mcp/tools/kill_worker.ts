import { z } from "zod";
import type { McpToolModule } from "../tool-registry.ts";
import { safeText } from "../tool-registry.ts";

export const killWorkerTool: McpToolModule = {
  name: "kill_worker",
  register(server, session): void {
    server.registerTool(
      "kill_worker",
      {
        description: "Terminate a running worker via SIGTERM. Use when a worker is stuck or its task is no longer needed.",
        inputSchema: { id: z.string().describe("Worker id") },
      },
      async ({ id }) => safeText(async () => session.api("DELETE", `/workers/${id}`)),
    );
  },
};
