import { z } from "zod";
import type { McpToolModule } from "../tool-registry.ts";
import { safeText } from "../../shared/mcp-tool.ts";
import { commandRequest } from "../../../contracts/src/commands/types.ts";
import { killWorkerCommand } from "../../../contracts/src/commands/defs.ts";

export const killWorkerTool: McpToolModule = {
  name: "kill_worker",
  register(server, session): void {
    server.registerTool(
      "kill_worker",
      {
        inputSchema: { id: z.string().describe("Worker id, e.g. 'w-abcd1234'") },
      },
      async ({ id }) => safeText(async () => {
        const req = commandRequest(killWorkerCommand, { id, actorId: session.selfId }, {});
        return session.api(req.method, req.path, req.body);
      }),
    );
  },
};
