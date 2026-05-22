import { parseArgs } from "node:util";

import type { Command } from "./Command.ts";

export const approveCommand: Command = {
  name: "approve",
  description: "Approve a pending permission request (optionally rewrite the tool input)",
  usage: "claude-manager approve <pending-id> [--rewrite '<json>']",
  async run(args, ctx): Promise<void> {
    const { values, positionals } = parseArgs({
      args, allowPositionals: true,
      options: { rewrite: { type: "string" } },
    });
    const id = positionals[0];
    if (!id) { console.error("usage: approve <pending-id> [--rewrite '<json>']"); process.exit(1); }
    const body: Record<string, unknown> = { decision: "allow" };
    if (values.rewrite) {
      try { body.updatedInput = JSON.parse(values.rewrite); }
      catch { console.error("--rewrite must be valid JSON"); process.exit(1); }
    }
    const res = await ctx.api("POST", `/pending/${id}/decision`, body);
    console.log(JSON.stringify(res));
  },
};
