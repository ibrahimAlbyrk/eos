import { spawn } from "node:child_process";
import { join } from "node:path";

import type { Command } from "./Command.ts";

export const startCommand: Command = {
  name: "start",
  description: "Start the daemon and open the web UI (-f for foreground)",
  usage: "eos start [-f|--foreground]",
  async run(args, ctx): Promise<void> {
    const foreground = args.includes("-f") || args.includes("--foreground");

    if (foreground) {
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
        console.error("daemon failed to start — run `eos start -f` for foreground diagnostics");
        process.exit(1);
      }
    }

    const webUrl = `${ctx.daemonUrl}/web/`;
    console.log(`eos → ${webUrl}`);
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    try {
      const op = spawn(opener, [webUrl], { stdio: "ignore", detached: true });
      op.unref();
    } catch {
      console.log("open the URL above in your browser.");
    }
  },
};
