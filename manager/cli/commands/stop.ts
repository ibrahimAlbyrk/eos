import type { Command } from "./Command.ts";
import { stopDaemon } from "../daemon-lifecycle.ts";

export const stopCommand: Command = {
  name: "stop",
  description: "Stop the daemon",
  usage: "eos stop",
  async run(args, ctx): Promise<void> {
    if (args.length > 0) {
      console.error("usage: eos stop\n(to kill a worker, use: eos kill <id>)");
      process.exit(1);
    }
    if (!(await stopDaemon(ctx.config.daemon.pidFile))) console.log("(no daemon running)");
  },
};
