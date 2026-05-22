import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import type { Command } from "./Command.ts";

export const daemonCommand: Command = {
  name: "daemon",
  description: "Start, stop, or check the claude-manager daemon",
  usage: "claude-manager daemon [start|stop|status]",
  async run(args, ctx): Promise<void> {
    const sub = args[0] ?? "start";
    if (sub === "start") {
      const child = spawn(
        "node",
        ["--no-warnings", "--experimental-strip-types", join(ctx.repoRoot, "manager", "daemon.ts")],
        { stdio: "inherit" },
      );
      child.on("exit", (c) => process.exit(c ?? 0));
      process.on("SIGINT", () => child.kill("SIGINT"));
      process.on("SIGTERM", () => child.kill("SIGTERM"));
      return;
    }
    if (sub === "stop") {
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
      return;
    }
    if (sub === "status") {
      try {
        const r = await fetch(`${ctx.daemonUrl}/health`);
        if (r.ok) console.log(`daemon up at ${ctx.daemonUrl}`);
        else console.log(`daemon at ${ctx.daemonUrl} returned ${r.status}`);
      } catch (e) {
        console.log(`daemon not reachable at ${ctx.daemonUrl}: ${(e as Error).message}`);
      }
      return;
    }
    console.error("usage: claude-manager daemon [start|stop|status]");
    process.exit(1);
  },
};
