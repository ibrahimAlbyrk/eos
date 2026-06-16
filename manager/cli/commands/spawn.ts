import { parseArgs } from "node:util";
import { join } from "node:path";

import type { Command } from "./Command.ts";
import { commandRequest } from "../../../contracts/src/commands/types.ts";
import { spawnWorkerCommand } from "../../../contracts/src/commands/defs.ts";

export const spawnCommand: Command = {
  name: "spawn",
  description: "Spawn a worker in --cwd <dir> or --worktree-from <repo>",
  usage: "eos spawn (--cwd <dir> | --worktree-from <repo>) --prompt <text> [--name <id>] [--branch <b>] [--with-gateway] [--model opus|sonnet|haiku]",
  async run(args, ctx): Promise<void> {
    const { values } = parseArgs({
      args,
      options: {
        cwd: { type: "string" },
        "worktree-from": { type: "string" },
        branch: { type: "string" },
        prompt: { type: "string" },
        name: { type: "string" },
        "with-gateway": { type: "boolean", default: false },
        model: { type: "string" },
      },
      strict: true,
    });
    if (!values.prompt) {
      console.error("error: --prompt required");
      process.exit(1);
    }
    if (!values.cwd && !values["worktree-from"]) {
      console.error("error: --cwd or --worktree-from required");
      process.exit(1);
    }
    const req = commandRequest(spawnWorkerCommand, {}, {
      prompt: values.prompt,
      cwd: values.cwd,
      worktreeFrom: values["worktree-from"],
      branch: values.branch,
      name: values.name,
      withGateway: values["with-gateway"],
      model: values.model,
    });
    const res = (await ctx.api(req.method, req.path, req.body)) as { id: string; port: number };
    console.log(`spawned: ${res.id}  port=${res.port}`);
    console.log(`logs: ${join(ctx.logDir, res.id + ".log")}`);
  },
};
