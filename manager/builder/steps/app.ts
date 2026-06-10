// Native macOS app bundle. build.sh embeds EOS_BUILD_STAMP into the bundle
// BEFORE codesign so the signature stays valid. Never quits the running app:
// the process keeps its old inodes, and all app lifecycle belongs to the
// relaunch epilogue.

import { join } from "node:path";

import { APP_STAMP_PATH } from "../app-control.ts";
import type { BuildStep } from "../BuildStep.ts";
import { computeStamp } from "../hash.ts";
import { appSpec } from "../inputs.ts";
import { runOrThrow } from "../proc.ts";
import { readStampFile } from "../stamps.ts";

export const appStep: BuildStep = {
  id: "app",
  verb: { run: "rebuilding", done: "rebuilt" },
  missingReason: "no bundle stamp",
  desiredStamp: (ctx) => computeStamp(appSpec(ctx.repoRoot)),
  currentStamp: () => readStampFile(APP_STAMP_PATH),
  async apply(ctx, desired): Promise<void> {
    await runOrThrow("bash", [join(ctx.repoRoot, "app", "build.sh")], {
      env: { ...process.env, EOS_BUILD_STAMP: desired },
    });
  },
};
