import { z } from "zod";
import type { McpToolModule } from "../tool-registry.ts";
import { safeText } from "../../shared/mcp-tool.ts";

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

export const askPeerTool: McpToolModule = {
  name: "ask_peer",
  register(server, session): void {
    server.registerTool(
      "ask_peer",
      {
        inputSchema: {
          peerId: z.string().describe("The id of the peer to consult (from list_peers)."),
          question: z.string().describe(
            "One focused, self-contained question. The peer cannot see your task — give it the context it needs to answer.",
          ),
        },
      },
      async ({ peerId, question }) =>
        safeText(async () => {
          const reg = (await session.api("POST", `/workers/${peerId}/peer-request`, {
            fromWorker: session.selfId,
            question,
          })) as RegisterResult;
          if (!reg.requestId) {
            return reg.reason ?? "The peer could not be consulted. Proceed on your best judgment.";
          }

          for (;;) {
            await sleep(POLL_INTERVAL_MS);
            let state: PollState;
            try {
              state = (await session.api(
                "GET",
                `/workers/${peerId}/peer-request/${reg.requestId}`,
              )) as PollState;
            } catch {
              continue; // transient daemon hiccup — the request still stands
            }
            if (state.status === "answered") return state.answer ?? "";
            if (state.status === "declined") {
              return `The peer did not answer: ${state.reason ?? "no reason given"}. Proceed on your best judgment.`;
            }
            if (state.status === "gone") {
              return "The peer is no longer available (it was stopped, or the daemon restarted). Proceed on your best judgment, or consult a different peer.";
            }
          }
        }),
    );
  },
};
