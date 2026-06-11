import { z } from "zod";
import type { McpToolModule } from "../tool-registry.ts";
import { safeText } from "../tool-registry.ts";

export const killWorkerTool: McpToolModule = {
  name: "kill_worker",
  register(server, session): void {
    server.registerTool(
      "kill_worker",
      {
        description:
          "Terminate a worker via SIGTERM. Termination is graceful (the worker gets its Stop hook before exit). Only works on workers you spawned.\n\nWhen to use:\n1. The worker's task is complete AND the user has acknowledged the result — frees resources.\n2. The worker is stuck (no progress events for a while, infinite-loop pattern in events, or `failed:` report with no recovery path).\n3. The user explicitly asks to cancel it.\n\nWhen NOT to use:\n- The worker just reported and the user might want a follow-up — wait for the exchange to conclude first.\n- During an active permission ask (worker in list_pending_permissions) — decide the permission first.\n\nReturns the worker's final state.",
        inputSchema: { id: z.string().describe("Worker id, e.g. 'w-abcd1234'") },
      },
      async ({ id }) => safeText(async () => session.api("DELETE", `/workers/${id}?actorId=${session.selfId}`)),
    );
  },
};
