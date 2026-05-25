import type { Command } from "./Command.ts";

export const killCommand: Command = {
  name: "kill",
  description: "Terminate a worker or orchestrator (SIGTERM + DB row removal)",
  usage: "eos kill <id>",
  async run(args, ctx): Promise<void> {
    const id = args[0];
    if (!id) { console.error("usage: kill <id>"); process.exit(1); }
    const res = (await ctx.api("DELETE", `/workers/${id}`)) as { killing?: boolean; error?: string };
    if (res.killing) console.log(`killing ${id}`);
    else console.log(JSON.stringify(res));
  },
};
