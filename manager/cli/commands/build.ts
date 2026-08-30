import { join } from "node:path";

import type { Command } from "./Command.ts";
import { buildAndInstallApp } from "../../builder/app-install.ts";
import { runBuild } from "../../builder/engine.ts";
import { buildSteps } from "../../builder/registry.ts";
import { run } from "../../builder/proc.ts";

const USAGE = "eos build [--dry-run] [--force] [--check] [--app]";
const FLAGS = new Set(["--dry-run", "--force", "--check", "--app"]);

export const buildCommand: Command = {
  name: "build",
  description:
    "Converge deps + daemon to current source — only what changed. Add --app to also build + install the Electron Eos.app into /Applications and relaunch (destructive: replaces the running app + restarts its daemon)",
  usage: USAGE,
  async run(args, ctx): Promise<void> {
    for (const a of args) {
      if (!FLAGS.has(a)) {
        console.error(`unknown flag: ${a}`);
        console.error(`usage: ${USAGE}`);
        process.exit(2);
      }
    }

    if (args.includes("--check")) {
      const checks: Array<{ label: string; cwd: string }> = [
        { label: "lint", cwd: ctx.repoRoot },
        { label: "manager tests", cwd: join(ctx.repoRoot, "manager") },
        { label: "contracts tests", cwd: join(ctx.repoRoot, "contracts") },
        { label: "infra tests", cwd: join(ctx.repoRoot, "infra") },
      ];
      for (const check of checks) {
        process.stdout.write(`check: ${check.label}… `);
        const npmArgs = check.label === "lint" ? ["run", "lint"] : ["test"];
        const r = await run("npm", npmArgs, { cwd: check.cwd });
        if (r.code !== 0) {
          console.log("FAIL");
          console.error(r.tail);
          process.exit(1);
        }
        console.log("ok");
      }
    }

    const ok = await runBuild(
      {
        repoRoot: ctx.repoRoot,
        daemonUrl: ctx.daemonUrl,
        eosHome: ctx.config.daemon.home,
        pidFile: ctx.config.daemon.pidFile,
        socketFile: ctx.config.daemon.socketFile,
        force: args.includes("--force"),
        dryRun: args.includes("--dry-run"),
        log: (line) => console.log(line),
      },
      buildSteps(),
    );
    if (!ok) process.exit(1);

    // --app is opt-in: normal `eos build` stays deps+daemon only. The app build +
    // install is destructive (swaps /Applications/Eos.app + restarts its daemon,
    // ending the current session), so it never runs without the explicit flag.
    if (args.includes("--app")) {
      await buildAndInstallApp({
        repoRoot: ctx.repoRoot,
        pidFile: ctx.config.daemon.pidFile,
        dryRun: args.includes("--dry-run"),
        log: (line) => console.log(line),
      });
    }
  },
};
