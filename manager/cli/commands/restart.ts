import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { Command } from "./Command.ts";
import { spawnDaemonDetached, stopDaemonAndOrphans, unreachableHint, waitHealthy } from "../daemon-lifecycle.ts";

export const restartCommand: Command = {
  name: "restart",
  description: "Stop daemon, kill orphans, restart. Pass --db to also wipe state.db",
  usage: "eos restart [--db]",
  async run(args, ctx): Promise<void> {
    const wipeDb = args.includes("--db");

    await stopDaemonAndOrphans(ctx.config.daemon.pidFile);

    if (wipeDb) {
      try {
        for (const f of readdirSync(ctx.config.daemon.home)) {
          if (f.startsWith("state.db")) rmSync(join(ctx.config.daemon.home, f), { force: true });
        }
      } catch {}
    }
    console.log(wipeDb ? "cleaned db + pid" : "cleaned pid");

    spawnDaemonDetached(ctx.repoRoot, join(ctx.config.daemon.logDir, "daemon.log"));

    const health = await waitHealthy(ctx.daemonUrl, 20, ctx.config.daemon.socketFile);
    if (health.state === "up") {
      console.log(`daemon up at ${ctx.daemonUrl}`);
      return;
    }
    // "unreachable" is a local-network verdict, not a daemon verdict: the daemon
    // it just spawned may be perfectly healthy and only the probe is impossible.
    if (health.state === "unreachable") {
      console.error(`daemon spawned but cannot be reached — ${unreachableHint(health.code)}`);
      process.exit(1);
    }
    console.error("daemon failed to start");
    process.exit(1);
  },
};
