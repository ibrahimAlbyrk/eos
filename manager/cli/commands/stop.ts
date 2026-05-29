import { existsSync, readFileSync, unlinkSync } from "node:fs";

import type { Command } from "./Command.ts";
import { errMsg } from "../../../contracts/src/util.ts";

export const stopCommand: Command = {
  name: "stop",
  description: "Stop the daemon",
  usage: "eos stop",
  async run(args, ctx): Promise<void> {
    if (args.length > 0) {
      console.error("usage: eos stop\n(to kill a worker, use: eos kill <id>)");
      process.exit(1);
    }
    const pidFile = ctx.config.daemon.pidFile;
    if (!existsSync(pidFile)) { console.log("(no daemon running)"); return; }
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    if (!pid || isNaN(pid)) {
      console.log("corrupt pid file; removing");
      try { unlinkSync(pidFile); } catch {}
      return;
    }
    try {
      process.kill(pid, "SIGTERM");
      console.log(`sent SIGTERM to daemon pid=${pid}`);
    } catch (e) {
      console.log(`daemon pid=${pid} not alive (${errMsg(e)}); cleaning pid file`);
      try { unlinkSync(pidFile); } catch {}
    }
  },
};
