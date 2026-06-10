// npm install per package dir (NOT a workspace). Stamp covers package.json,
// package-lock.json and the node version (native deps like node-pty rebuild
// on ABI changes). Stamp is recomputed AFTER install because npm may rewrite
// the lockfile.

import { join } from "node:path";

import type { BuildCtx, BuildStep } from "../BuildStep.ts";
import { computeStamp } from "../hash.ts";
import { DEPS_DIRS, depsSpec } from "../inputs.ts";
import { runOrThrow } from "../proc.ts";
import { readStampFile, writeStampFile } from "../stamps.ts";

function stampPath(ctx: BuildCtx, dir: string): string {
  return join(ctx.repoRoot, dir, "node_modules", ".eos-stamp");
}

export function depsSteps(): BuildStep[] {
  return DEPS_DIRS.map((dir) => ({
    id: dir === "." ? "deps:root" : `deps:${dir}`,
    verb: { run: "installing", done: "installed" },
    missingReason: "no install stamp",
    desiredStamp: (ctx: BuildCtx) => computeStamp(depsSpec(ctx.repoRoot, dir)),
    currentStamp: (ctx: BuildCtx) => readStampFile(stampPath(ctx, dir)),
    async apply(ctx: BuildCtx): Promise<void> {
      await runOrThrow("npm", ["install"], { cwd: join(ctx.repoRoot, dir) });
      writeStampFile(stampPath(ctx, dir), computeStamp(depsSpec(ctx.repoRoot, dir)));
    },
  }));
}
