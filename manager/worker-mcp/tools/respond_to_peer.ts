import { z } from "zod";
import type { McpToolModule } from "../tool-registry.ts";
import { safeText } from "../../shared/mcp-tool.ts";

export const respondToPeerTool: McpToolModule = {
  name: "respond_to_peer",
  register(server, session): void {
    server.registerTool(
      "respond_to_peer",
      {
        inputSchema: {
          answer: z.string().describe(
            "Your complete answer to the peer request delivered this turn. This is the only thing that reaches the asking peer — plain text in your turn does not.",
          ),
        },
      },
      async ({ answer }) =>
        safeText(async () => {
          const r = (await session.api("POST", `/workers/${session.selfId}/peer-response`, {
            answer,
          })) as { outcome?: string; toWorker?: string; toName?: string | null };
          if (r.outcome !== "answered") {
            return "No peer request was waiting on you (it may have been withdrawn or already answered). Nothing was delivered.";
          }
          // JSON so the responder's chat can label the tool with the asker's
          // name (and link to it); the agent just sees a delivery confirmation.
          return JSON.stringify({ delivered: true, toWorker: r.toWorker ?? null, toName: r.toName ?? null });
        }),
    );
  },
};
