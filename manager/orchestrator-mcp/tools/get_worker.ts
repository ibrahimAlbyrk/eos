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
          "Get a worker's full state plus its 30 most recent events.\n\nWhen to use: the user explicitly asks for an update on a specific worker, or you need to inspect why a worker just reported `failed:` to decide how to recover.\n\nWhen NOT to use: as a polling mechanism after spawning. Workers report via send_message_to_parent — wait for that signal rather than polling. Calling get_worker repeatedly wastes context with no new information.\n\nReturns: { worker: {id, state, prompt, cost_usd, ...}, events: [...] }. Events include tool calls, permission requests, and lifecycle markers; the most recent event is last in the array.",
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
