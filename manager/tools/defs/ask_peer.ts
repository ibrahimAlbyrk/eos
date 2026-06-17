import { z } from "zod";
import type { ToolDefinition } from "../types.ts";

// Register-then-poll, mirroring ask_user: a single long-lived wait would hit the
// CLI's MCP ceiling, so short GETs every few seconds block until the peer
// answers (it may take a while — the peer has to work). The answerer is another
// agent (via respond_to_peer), not a human.
const POLL_INTERVAL_MS = 2500;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface RegisterResult {
  requestId?: string;
  declined?: boolean;
  reason?: string;
}

interface PollState {
  status: "pending" | "answered" | "declined" | "gone";
  answer?: string;
  reason?: string;
}

export const askPeerDef: ToolDefinition = {
  name: "ask_peer",
  visibility: "peer",
  inputSchema: {
    peerId: z.string().describe("The id of the peer to consult (from list_peers)."),
    question: z.string().describe(
      "One focused, self-contained question. The peer cannot see your task — give it the context it needs to answer.",
    ),
  },
  handler: async (ctx, args) => {
    const { peerId, question } = args as { peerId: string; question: string };
    const reg = (await ctx.api("POST", `/workers/${peerId}/peer-request`, {
      fromWorker: ctx.selfId,
      question,
    })) as RegisterResult;
    if (!reg.requestId) {
      return reg.reason ?? "The peer could not be consulted. Proceed on your best judgment.";
    }

    for (;;) {
      await sleep(POLL_INTERVAL_MS);
      let state: PollState;
      try {
        state = (await ctx.api(
          "GET",
          `/workers/${peerId}/peer-request/${reg.requestId}`,
        )) as PollState;
      } catch {
        continue; // transient daemon hiccup — the request still stands
      }
      if (state.status === "answered") return state.answer ?? "";
      if (state.status === "declined") {
        return `The peer did not answer: ${state.reason ?? "no reason given"}. Proceed on your best judgment, or — if you are truly blocked without it — finish with a 'needs input:'/'failed:' report explaining what you needed.`;
      }
      if (state.status === "gone") {
        return "The peer you consulted is no longer available — it was stopped, crashed, or exited before answering, so no answer will come. Proceed without its input if you can, or finish with a 'needs input:'/'failed:' report saying you were blocked on it.";
      }
    }
  },
};
