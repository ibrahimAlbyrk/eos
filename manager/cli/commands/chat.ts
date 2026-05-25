import { parseArgs } from "node:util";

import type { Command } from "./Command.ts";
import { resolveChatTarget } from "./orchestrator.ts";

export const chatCommand: Command = {
  name: "chat",
  description: "Send a message to an orchestrator (auto-target when exactly one is active)",
  usage: "eos chat [--to <orchestrator-id>] <message...>",
  async run(args, ctx): Promise<void> {
    const { values, positionals } = parseArgs({
      args, allowPositionals: true,
      options: { to: { type: "string" } },
      strict: true,
    });
    const text = positionals.join(" ").trim();
    if (!text) { console.error("usage: chat [--to <orchestrator-id>] <message...>"); process.exit(1); }
    const targetId = await resolveChatTarget(values.to, ctx);
    const res = await ctx.api("POST", `/orchestrators/${targetId}/message`, { text });
    console.log(JSON.stringify(res));
  },
};
