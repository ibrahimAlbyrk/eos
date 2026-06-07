import { z } from "zod";
import type { McpToolModule } from "../tool-registry.ts";
import { safeText } from "../tool-registry.ts";

export const sendMessageToParentTool: McpToolModule = {
  name: "send_message_to_parent",
  register(server, session): void {
    server.registerTool(
      "send_message_to_parent",
      {
        description:
          "Send your final report for the current directive to the orchestrator. Call this exactly ONCE per directive cycle, at the end.\n\nThe FIRST line of `text` must be a status signal that gets parsed:\n  - `result: <one-line headline>` — task completed successfully\n  - `needs input: <one-line ask>` — blocked on a decision a human must make\n  - `failed: <one-line reason>` — task structurally impossible as framed\n\nThen on subsequent lines, in order:\n  1. What you did (2-3 bullets, no tool-output repetition)\n  2. Verification you ran (`npm test passes`, `tsc clean`, etc.)\n  3. Artifacts (changed file paths, commit hashes, IDs/URLs)\n  4. Out-of-scope notes (one line, only if relevant)\n  5. Handover (REQUIRED when working in an isolated worktree): `Handover: branch <cm-*>; verified by <command + verdict: passed|failed|blocked|unverified>; to try: <command>`\n\nDo NOT use this for progress narration mid-task — narrate in plain text instead (the dashboard shows it live). Do NOT use this to ask clarifying questions before starting work; make a reasonable assumption and state it in your final report.\n\nAfter this returns, end your turn. The orchestrator or the human operator may reply with a follow-up message; treat it as a fresh directive when it arrives.",
        inputSchema: {
          text: z.string().describe(
            "The report text. First line MUST be `result: ...`, `needs input: ...`, or `failed: ...`. Subsequent lines: what you did, verification, artifacts, out-of-scope notes.",
          ),
        },
      },
      async ({ text }) =>
        safeText(async () => {
          await session.api("POST", `/workers/${session.selfId}/report`, { text });
          return "Message delivered to orchestrator.";
        }),
    );
  },
};
