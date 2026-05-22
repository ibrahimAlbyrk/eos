import { spawn } from "node:child_process";
import { join } from "node:path";

import type { Command } from "./Command.ts";

export const webCommand: Command = {
  name: "web",
  description: "Open the web UI in the default browser (starts daemon if needed)",
  usage: "claude-manager web",
  async run(_args, ctx): Promise<void> {
    let alive = false;
    try {
      const r = await fetch(`${ctx.daemonUrl}/health`);
      alive = r.ok;
    } catch {}
    if (!alive) {
      console.log("starting daemon…");
      const child = spawn(
        "node",
        ["--no-warnings", "--experimental-strip-types", join(ctx.repoRoot, "manager", "daemon.ts")],
        { stdio: ["ignore", "ignore", "ignore"], detached: true },
      );
      child.unref();
      for (let i = 0; i < 40; i++) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        try {
          const r = await fetch(`${ctx.daemonUrl}/health`);
          if (r.ok) { alive = true; break; }
        } catch {}
      }
      if (!alive) {
        console.error("daemon failed to start — see ~/.claude-mgr/logs or run `claude-manager daemon start` manually");
        process.exit(1);
      }
    }
    const webUrl = `${ctx.daemonUrl}/web/`;
    console.log(`claude-manager web → ${webUrl}`);
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    try {
      const op = spawn(opener, [webUrl], { stdio: "ignore", detached: true });
      op.unref();
    } catch {
      console.log("open the URL above in your browser.");
    }
  },
};
