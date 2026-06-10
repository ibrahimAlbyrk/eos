import { join } from "node:path";

import type { Command } from "./Command.ts";
import { runBuild } from "../../builder/engine.ts";
import { buildSteps } from "../../builder/registry.ts";
import { run } from "../../builder/proc.ts";

const USAGE = "eos build [--dry-run] [--force] [--check] [--no-app] [--open]";
const FLAGS = new Set(["--dry-run", "--force", "--check", "--no-app", "--open"]);

export const buildCommand: Command = {
  name: "build",
  description:
    "Converge everything to current source: deps, web dist, macOS app, daemon, app relaunch — only what changed",
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
        { label: "web tests", cwd: join(ctx.repoRoot, "manager", "web") },
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
        force: args.includes("--force"),
        dryRun: args.includes("--dry-run"),
        noApp: args.includes("--no-app"),
        open: args.includes("--open"),
        log: (line) => console.log(line),
      },
      buildSteps(),
    );
    if (!ok) process.exit(1);
  },
};
