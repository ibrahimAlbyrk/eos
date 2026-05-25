import { spawn } from "node:child_process";
import { existsSync, createReadStream } from "node:fs";
import { join } from "node:path";

import type { Command } from "./Command.ts";

export const logsCommand: Command = {
  name: "logs",
  description: "Tail a worker's stdout/stderr log file",
  usage: "eos logs <id> [-f|--follow]",
  async run(args, ctx): Promise<void> {
    const id = args[0];
    if (!id) { console.error("usage: logs <id> [-f]"); process.exit(1); }
    const path = join(ctx.logDir, `${id}.log`);
    if (!existsSync(path)) {
      console.error(`no log file: ${path}`);
      process.exit(1);
    }
    const follow = args.includes("-f") || args.includes("--follow");
    if (follow) {
      const child = spawn("tail", ["-f", path], { stdio: "inherit" });
      process.on("SIGINT", () => child.kill());
    } else {
      createReadStream(path).pipe(process.stdout);
    }
  },
};
