import type { Command } from "./Command.ts";

export const statusCommand: Command = {
  name: "status",
  description: "Check daemon status",
  usage: "eos status",
  async run(_args, ctx): Promise<void> {
    try {
      const r = await fetch(`${ctx.daemonUrl}/health`);
      if (r.ok) console.log(`daemon up at ${ctx.daemonUrl}`);
      else console.log(`daemon at ${ctx.daemonUrl} returned ${r.status}`);
    } catch (e) {
      console.log(`daemon not reachable at ${ctx.daemonUrl}: ${(e as Error).message}`);
    }
  },
};
