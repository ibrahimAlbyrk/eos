import { existsSync, readFileSync, unlinkSync } from "node:fs";

import type { Command } from "./Command.ts";

export const stopCommand: Command = {
  name: "stop",
  description: "Stop the daemon",
  usage: "eos stop",
  async run(_args, ctx): Promise<void> {
    const pidFile = ctx.config.daemon.pidFile;
    if (!existsSync(pidFile)) { console.log("(no daemon running)"); return; }
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    try {
      process.kill(pid, "SIGTERM");
      console.log(`sent SIGTERM to daemon pid=${pid}`);
    } catch (e) {
      console.log(`daemon pid=${pid} not alive (${(e as Error).message}); cleaning pid file`);
      try { unlinkSync(pidFile); } catch {}
    }
  },
};
