import { z } from "zod";
import type { ToolDefinition } from "../types.ts";

export const respondToPeerDef: ToolDefinition = {
  name: "respond_to_peer",
  visibility: "peer",
  inputSchema: {
    answer: z.string().describe(
      "Your complete, self-contained answer to the peer request delivered this turn.",
    ),
  },
  handler: async (ctx, args) => {
    const { answer } = args as { answer: string };
    const r = (await ctx.api("POST", `/workers/${ctx.selfId}/peer-response`, {
      answer,
    })) as { outcome?: string; toWorker?: string; toName?: string | null };
    if (r.outcome !== "answered") {
      return "No peer request was waiting on you (it may have been withdrawn or already answered). Nothing was delivered.";
    }
    // JSON so the responder's chat can label the tool with the asker's
    // name (and link to it); the agent just sees a delivery confirmation.
    return JSON.stringify({ delivered: true, toWorker: r.toWorker ?? null, toName: r.toName ?? null });
  },
};
