import { z } from "zod";
import type { ToolDefinition } from "../types.ts";

// Register-then-poll: a single long-lived HTTP wait would hit undici's
// headersTimeout and the CLI's MCP tool ceiling; short GETs every few seconds
// wait indefinitely (the operator may answer days later) and survive transient
// daemon hiccups. A "gone" status (daemon restart, supersede) is the only
// non-answer exit.
const POLL_INTERVAL_MS = 2500;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface PollState {
  status: "pending" | "answered" | "dismissed" | "gone";
  answers?: Record<string, string>;
}

export const askUserDef: ToolDefinition = {
  name: "ask_user",
  visibility: "orchestrator",
  inputSchema: {
    questions: z
      .array(
        z.object({
          question: z.string().describe("The complete question, ending with a question mark."),
          header: z.string().optional().describe("Short chip label, max ~12 chars. E.g. 'Approach'."),
          multiSelect: z.boolean().optional().describe("Allow picking several options."),
          options: z
            .array(
              z.object({
                label: z.string().describe("Concise choice text (1-5 words)."),
                description: z.string().optional().describe("What this choice means / its trade-off."),
              }),
            )
            .min(2)
            .max(4)
            .describe("2-4 distinct choices. The dashboard adds a free-text 'Other' automatically."),
        }),
      )
      .min(1)
      .max(4)
      .describe("1-4 questions, shown to the operator as one banner."),
  },
  handler: async (ctx, args) => {
    const { questions } = args as { questions: unknown };
    const reg = (await ctx.api("POST", `/workers/${ctx.selfId}/question`, {
      questions,
    })) as { questionId: string };

    for (;;) {
      await sleep(POLL_INTERVAL_MS);
      let state: PollState;
      try {
        state = (await ctx.api(
          "GET",
          `/workers/${ctx.selfId}/question/${reg.questionId}`,
        )) as PollState;
      } catch {
        continue; // transient daemon hiccup — the question still stands
      }
      if (state.status === "answered") return { answers: state.answers ?? {} };
      if (state.status === "dismissed") {
        return "The user dismissed the question without answering. Proceed on your best judgment; if you stay blocked, say so in chat and notify_user.";
      }
      if (state.status === "gone") {
        return "The question is no longer tracked (daemon restarted or the question was superseded). Ask again if you still need the answer.";
      }
    }
  },
};
