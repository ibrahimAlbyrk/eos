import { z } from "zod";
import type { ToolDefinition } from "../types.ts";

// Register-then-poll, mirroring ask_user: a single long-lived wait would hit the
// CLI's MCP ceiling, so short GETs every few seconds block until the peer
// answers (it may take a while — the peer has to work). The answerer is another
// agent (via respond_to_peer), not a human. Addressed by name, the consult also
// blocks while the named peer hasn't spawned yet — it parks server-side
// (awaiting → reads as pending here) until that peer joins, then is delivered.
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
    peerId: z.string().optional().describe(
      "The id of the peer to consult (from list_peers) — for a peer you can already see.",
    ),
    peerName: z.string().optional().describe(
      "The name of the peer to consult (the slug the orchestrator gave it, e.g. 'auth-expert'). Use this when the peer may not have spawned yet — the consult waits until a peer with this name joins. Pass peerId OR peerName, not both.",
    ),
    question: z.string().describe(
      "One focused, self-contained question, with the context the peer needs to answer.",
    ),
  },
  handler: async (ctx, args) => {
    const { peerId, peerName, question } = args as { peerId?: string; peerName?: string; question: string };
    const target = peerId != null ? { id: peerId } : peerName != null ? { name: peerName } : null;
    if (!target) {
      return "Pass either peerId (from list_peers) or peerName (the name the orchestrator gave the peer). Nothing was sent.";
    }
    const reg = (await ctx.api("POST", `/workers/${ctx.selfId}/peer-request`, {
      target,
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
          `/workers/${ctx.selfId}/peer-request/${reg.requestId}`,
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
