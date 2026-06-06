import { z } from "zod";
import type { McpToolModule } from "../tool-registry.ts";
import { safeText } from "../tool-registry.ts";

export const notifyUserTool: McpToolModule = {
  name: "notify_user",
  register(server, session): void {
    server.registerTool(
      "notify_user",
      {
        description:
          "Send a native system notification to the user. Delivered only while the app is in the background — if the user is actively watching, it is invisible, so it never replaces a chat reply.\n\nWhen to use:\n- The OVERALL task the user asked for is complete — every worker it required has reported, not just one of them.\n- You are blocked and cannot proceed without the user (a worker failed unrecoverably, or you need a decision/input).\n- The user explicitly asked to be told when something specific happens.\n\nWhen NOT to use:\n- Partial progress (e.g. 1 of 3 workers finished — wait until the whole task is done).\n- Routine status updates or anything you are about to say in chat anyway.\n- More than once for the same fact.\n\nKeep the title a few words; the body one sentence stating the concrete outcome.",
        inputSchema: {
          title: z.string().describe("Short headline, a few words. E.g. 'Task complete'"),
          body: z.string().describe("One sentence with the concrete outcome. E.g. 'Auth refactor done across 3 workers — review ready.'"),
        },
      },
      async ({ title, body }) =>
        safeText(async () => {
          return await session.api("POST", `/workers/${session.selfId}/notify`, { title, body });
        }),
    );
  },
};
