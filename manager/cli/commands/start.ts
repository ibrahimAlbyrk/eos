import { spawn } from "node:child_process";
import { join } from "node:path";

import type { Command } from "./Command.ts";
import { spawnDaemonDetached, waitHealthy } from "../daemon-lifecycle.ts";

export const startCommand: Command = {
  name: "start",
  description: "Start the daemon and open the Eos app (-f for foreground)",
  usage: "eos start [-f|--foreground]",
  async run(args, ctx): Promise<void> {
    const foreground = args.includes("-f") || args.includes("--foreground");

    if (foreground) {
      try {
        const r = await fetch(`${ctx.daemonUrl}/health`);
        if (r.ok) { console.error(`daemon already running at ${ctx.daemonUrl}`); process.exit(1); }
      } catch {}
      const child = spawn(
        "node",
        // Match spawnDaemonDetached: 1024MB runaway guard, generous over the
        // ~80MB baseline so it never OOMs under normal load.
        ["--max-old-space-size=1024", "--no-warnings", "--experimental-strip-types", join(ctx.repoRoot, "manager", "daemon.ts")],
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
      spawnDaemonDetached(ctx.repoRoot);
      alive = (await waitHealthy(ctx.daemonUrl, 40)) !== null;
      if (!alive) {
        console.error("daemon failed to start — run `eos start -f` for foreground diagnostics");
        process.exit(1);
      }
    }

    // The UI ships as the native Eos.app (WKWebView) — there is no browser web
    // UI to open anymore. Bring the app to the foreground on macOS.
    console.log(`eos daemon running at ${ctx.daemonUrl}`);
    if (process.platform === "darwin") {
      // `open -b` exits non-zero WITHOUT throwing when the bundle isn't registered
      // with LaunchServices (e.g. before `eos build`), so spawn alone can't tell us
      // it failed. Await the exit code and fall back to a hint instead of silently
      // opening nothing. `open` returns immediately, so this doesn't stall.
      const opened = await new Promise<boolean>((resolve) => {
        const op = spawn("open", ["-b", "com.ibrahimalbyrk.eos"], { stdio: "ignore" });
        op.on("error", () => resolve(false));
        op.on("exit", (code) => resolve(code === 0));
      });
      if (!opened) console.log("Eos.app not found — run `eos build`, then open it to use the UI.");
    }
  },
};
