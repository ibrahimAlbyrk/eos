import type { Command } from "./Command.ts";
import { commandRequest } from "../../../contracts/src/commands/types.ts";
import { killWorkerCommand } from "../../../contracts/src/commands/defs.ts";

export const killCommand: Command = {
  name: "kill",
  description: "Terminate a worker or orchestrator (SIGTERM + DB row removal)",
  usage: "eos kill <id>",
  async run(args, ctx): Promise<void> {
    const id = args[0];
    if (!id) { console.error("usage: kill <id>"); process.exit(1); }
    const req = commandRequest(killWorkerCommand, { id }, {});
    const res = (await ctx.api(req.method, req.path, req.body)) as { removed?: boolean };
    console.log(res.removed ? `killed ${id}` : JSON.stringify(res));
  },
};
