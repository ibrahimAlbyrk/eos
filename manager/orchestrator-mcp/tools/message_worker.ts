import { z } from "zod";
import type { McpToolModule } from "../tool-registry.ts";
import { safeText } from "../tool-registry.ts";

export const messageWorkerTool: McpToolModule = {
  name: "message_worker",
  register(server, session): void {
    server.registerTool(
      "message_worker",
      {
        description:
          "Send a follow-up message to a running worker. The text becomes a new user-turn for the worker, starting a new directive cycle.\n\nWhen to use: after the worker has reported back (you received `[worker ... reported: ...]`) and the user wants a tweak, a redirect, a follow-up task, or wants to provide the input the worker asked for via `needs input:`.\n\nWhen NOT to use:\n- Before the worker has reported on its current directive — the worker is busy and your message will queue. Wait for the report.\n- To ask 'any progress?' — that information is in get_worker if you really need it. Don't interrupt with redundant queries.\n\nAfter messaging, the worker will resume on the new directive and eventually call send_message_to_parent again. Same lifecycle rules apply.",
        inputSchema: {
          id: z.string().describe("Worker id, e.g. 'w-abcd1234'"),
          text: z.string().describe(
            "The follow-up directive. Treat this like a fresh worker prompt — be specific. The worker has its prior context but you should still state the new ask clearly.",
          ),
        },
      },
      async ({ id, text }) =>
        safeText(async () => {
          return await session.api("POST", `/workers/${id}/message`, { text, fromParent: session.selfId });
        }),
    );
  },
};
