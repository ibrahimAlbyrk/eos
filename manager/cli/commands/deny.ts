import { parseArgs } from "node:util";

import type { Command } from "./Command.ts";

export const denyCommand: Command = {
  name: "deny",
  description: "Deny a pending permission request with an optional reason",
  usage: "claude-manager deny <pending-id> [--reason '<text>']",
  async run(args, ctx): Promise<void> {
    const { values, positionals } = parseArgs({
      args, allowPositionals: true,
      options: { reason: { type: "string" } },
    });
    const id = positionals[0];
    if (!id) { console.error("usage: deny <pending-id> [--reason '<text>']"); process.exit(1); }
    const res = await ctx.api("POST", `/pending/${id}/decision`, { decision: "deny", reason: values.reason ?? "denied" });
    console.log(JSON.stringify(res));
  },
};
