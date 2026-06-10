// Ordered step list — same registry pattern as cli/commands/registry.ts.
// Order is the deploy dependency order: deps before builds, daemon restart
// after artifacts, app relaunch runs as the engine epilogue.

import type { BuildStep } from "./BuildStep.ts";
import { appStep } from "./steps/app.ts";
import { daemonStep } from "./steps/daemon.ts";
import { depsSteps } from "./steps/deps.ts";
import { webStep } from "./steps/web.ts";

export function buildSteps(): BuildStep[] {
  return [...depsSteps(), webStep, appStep, daemonStep];
}
