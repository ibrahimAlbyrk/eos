import { z } from "zod";
import type { McpToolModule } from "../tool-registry.ts";
import { safeText } from "../tool-registry.ts";

export const spawnWorkerTool: McpToolModule = {
  name: "spawn_worker",
  register(server, session): void {
    server.registerTool(
      "spawn_worker",
      {
        description:
          "Spawn a new background Claude worker to handle a task. Returns the worker ID and port. The worker automatically runs in your project directory — you do not (and cannot) choose the path.",
        inputSchema: {
          prompt: z.string().describe("The task instruction for the worker. Be specific and self-contained."),
          name: z.string().optional().describe("Friendly name for the worker (e.g. 'add-auth-tests')."),
          withGateway: z.boolean().optional().describe("Default true. Routes the worker's tool calls through the permission gateway."),
          model: z.string().optional().describe("Claude model for the worker: 'opus' (default, strongest reasoning), 'sonnet' (balanced), or 'haiku' (fastest/cheapest). Pick based on task complexity."),
          maxCostUsd: z.number().optional().describe("Hard ceiling in USD. Worker SIGTERM'd if cumulative cost exceeds this."),
          maxElapsedMs: z.number().optional().describe("Hard ceiling in milliseconds since worker started."),
        },
      },
      async ({ prompt, name, withGateway, model, maxCostUsd, maxElapsedMs }) =>
        safeText(async () => {
          const body: Record<string, unknown> = {
            prompt, name, model,
            withGateway: withGateway ?? true,
            parentId: session.selfId,
            maxCostUsd, maxElapsedMs,
          };
          if (session.isGitRepo) body.worktreeFrom = session.cwd;
          else body.cwd = session.cwd;
          return await session.api("POST", "/workers", body);
        }),
    );
  },
};
