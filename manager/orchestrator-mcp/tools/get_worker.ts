import { z } from "zod";
import type { McpToolModule } from "../tool-registry.ts";
import { safeText } from "../tool-registry.ts";

export const getWorkerTool: McpToolModule = {
  name: "get_worker",
  register(server, session): void {
    server.registerTool(
      "get_worker",
      {
        description:
          "Get a worker's current state and recent events. Use this to check progress on a previously spawned worker.",
        inputSchema: { id: z.string().describe("Worker id, e.g. 'w-abcd1234'") },
      },
      async ({ id }) =>
        safeText(async () => {
          const [worker, events] = await Promise.all([
            session.api("GET", `/workers/${id}`),
            session.api("GET", `/workers/${id}/events?limit=30`),
          ]);
          return { worker, events };
        }),
    );
  },
};
