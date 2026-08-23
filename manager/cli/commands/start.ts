import { spawn } from "node:child_process";
import { join } from "node:path";

import type { Command } from "./Command.ts";
import { daemonPidAlive, probeDaemon, spawnDaemonDetached, unreachableHint, waitHealthy } from "../daemon-lifecycle.ts";

export const startCommand: Command = {
  name: "start",
  description: "Start the daemon and open the Eos app (-f for foreground)",
  usage: "eos start [-f|--foreground]",
  async run(args, ctx): Promise<void> {
    const foreground = args.includes("-f") || args.includes("--foreground");

    const socketFile = ctx.config.daemon.socketFile;

    if (foreground) {
      const probe = await probeDaemon(ctx.daemonUrl, socketFile);
      if (probe.state === "up") { console.error(`daemon already running at ${ctx.daemonUrl}`); process.exit(1); }
      // Never boot a second daemon on the strength of a probe that could not be
      // made: the ports would already be taken by the healthy one (EADDRINUSE).
      if (probe.state === "unreachable") {
        console.error(`cannot tell whether the daemon is running — ${unreachableHint(probe.code)}`);
        process.exit(1);
      }
      const pid = daemonPidAlive(ctx.config.daemon.pidFile);
      if (pid) { console.error(`daemon pid=${pid} is alive but not answering /health — stop it first (eos stop)`); process.exit(1); }
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

    const probe = await probeDaemon(ctx.daemonUrl, socketFile);
    if (probe.state === "unreachable") {
      console.error(`cannot reach the daemon — ${unreachableHint(probe.code)}`);
      process.exit(1);
    }
    if (probe.state === "down") {
      const stale = daemonPidAlive(ctx.config.daemon.pidFile);
      if (stale) {
        console.error(`daemon pid=${stale} is alive but not answering /health — stop it first (eos stop)`);
        process.exit(1);
      }
      console.log("starting daemon…");
      spawnDaemonDetached(ctx.repoRoot, join(ctx.config.daemon.logDir, "daemon.log"));
      const health = await waitHealthy(ctx.daemonUrl, 40, socketFile);
      if (health.state === "unreachable") {
        console.error(`daemon started but cannot be reached — ${unreachableHint(health.code)}`);
        process.exit(1);
      }
      if (health.state !== "up") {
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
