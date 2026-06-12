import { z } from "zod";
import type { McpToolModule } from "../tool-registry.ts";
import { safeText } from "../tool-registry.ts";

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

export const askUserTool: McpToolModule = {
  name: "ask_user",
  register(server, session): void {
    server.registerTool(
      "ask_user",
      {
        description:
          "Ask the operator a question and BLOCK until they answer in the dashboard. This is the replacement for the builtin AskUserQuestion tool, which is disabled in Eos.\n\nUse it only when the answer changes what you do next and you cannot resolve it from the request, prior reports, or sensible defaults: choosing between expensive-to-undo decompositions, a missing requirement, a destructive-action confirmation. Do NOT use it for progress updates (chat reply), completion/blocked taps (notify_user), or anything you can decide yourself.\n\nThe call returns the chosen labels (or free text) per question. The operator can also dismiss without answering — proceed on your best judgment then. There is no timeout; the answer may arrive much later, and your turn stays open until it does.",
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
      },
      async ({ questions }) =>
        safeText(async () => {
          const reg = (await session.api("POST", `/workers/${session.selfId}/question`, {
            questions,
          })) as { questionId: string };

          for (;;) {
            await sleep(POLL_INTERVAL_MS);
            let state: PollState;
            try {
              state = (await session.api(
                "GET",
                `/workers/${session.selfId}/question/${reg.questionId}`,
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
        }),
    );
  },
};
