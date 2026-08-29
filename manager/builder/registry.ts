// Ordered step list — same registry pattern as cli/commands/registry.ts.
// Order is the deploy dependency order: deps before the daemon restart. The GUI
// app (formerly the Swift Eos.app rebuilt+relaunched here) is now the Electron
// package at app/, which OWNS its own UI build — `cd app && npm run make` builds
// app/ui/dist. eos build no longer builds the web UI, the app, or relaunches it.

import type { BuildStep } from "./BuildStep.ts";
import { daemonStep } from "./steps/daemon.ts";
import { depsSteps } from "./steps/deps.ts";

export function buildSteps(): BuildStep[] {
  return [...depsSteps(), daemonStep];
}
