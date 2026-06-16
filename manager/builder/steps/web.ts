// Vite production build. The stamp is written AFTER the build because
// emptyOutDir wipes dist/ first — a failed build therefore leaves no stamp
// and stays dirty on the next run.

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { BuildCtx, BuildStep } from "../BuildStep.ts";
import { computeStamp } from "../hash.ts";
import { webSpec } from "../inputs.ts";
import { runOrThrow } from "../proc.ts";
import { readStampFile, writeStampFile } from "../stamps.ts";

export function webDistStampPath(repoRoot: string): string {
  return join(repoRoot, "app", "ui", "dist", ".eos-stamp");
}

export const webStep: BuildStep = {
  id: "web",
  verb: { run: "rebuilding", done: "rebuilt" },
  missingReason: "no dist stamp",
  desiredStamp: (ctx) => computeStamp(webSpec(ctx.repoRoot)),
  currentStamp: (ctx) => readStampFile(webDistStampPath(ctx.repoRoot)),
  async apply(ctx): Promise<void> {
    const webDir = join(ctx.repoRoot, "app", "ui");
    await runOrThrow("npm", ["run", "build"], { cwd: webDir });
    if (!existsSync(join(webDir, "dist", "index.html"))) {
      throw new Error("vite build produced no dist/index.html — web UI is broken until a rebuild succeeds");
    }
    writeStampFile(webDistStampPath(ctx.repoRoot), computeStamp(webSpec(ctx.repoRoot)));
  },
};
