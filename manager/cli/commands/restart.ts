import { execSync, spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { Command } from "./Command.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const restartCommand: Command = {
  name: "restart",
  description: "Stop daemon, kill orphans, clean DB, restart",
  usage: "eos restart",
  async run(_args, ctx): Promise<void> {
    // 1. Graceful stop
    const pidFile = ctx.config.daemon.pidFile;
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      try { process.kill(pid, "SIGTERM"); console.log(`stopped daemon pid=${pid}`); } catch {}
    }
    await sleep(1000);

    // 2. Kill orphans
    try {
      execSync('pkill -9 -f "manager/daemon.ts|spawner/worker.ts|orchestrator-mcp.ts|worker-mcp.ts|claude --settings"', { stdio: "ignore" });
    } catch {}
    await sleep(1000);

    // 3. Clean DB + pid
    const home = ctx.config.daemon.home;
    try {
      for (const f of readdirSync(home)) {
        if (f.startsWith("state.db") || f === "daemon.pid") {
          rmSync(join(home, f), { force: true });
        }
      }
    } catch {}
    console.log("cleaned db + pid");

    // 4. Start daemon (foreground, detached)
    const child = spawn(
      "node",
      ["--no-warnings", "--experimental-strip-types", join(ctx.repoRoot, "manager", "daemon.ts")],
      { stdio: ["ignore", "ignore", "ignore"], detached: true },
    );
    child.unref();

    // 5. Wait for health
    for (let i = 0; i < 20; i++) {
      await sleep(250);
      try {
        const r = await fetch(`${ctx.daemonUrl}/health`);
        if (r.ok) { console.log(`daemon up at ${ctx.daemonUrl}`); return; }
      } catch {}
    }
    console.error("daemon failed to start");
    process.exit(1);
  },
};
