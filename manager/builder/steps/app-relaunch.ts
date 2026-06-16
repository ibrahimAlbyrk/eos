// Deploy epilogue, not a BuildStep: the app is not an artifact to build but a
// running instance to refresh. The web UI ships inside the app bundle, so any
// UI change makes the bundle stale — there is no in-place page reload. A
// changed bundle (or a closed app with --open) is delivered by a verified
// quit+open; a closed app needs nothing — it loads everything fresh on launch.

import { statSync } from "node:fs";

import { APP_STAMP_PATH, appStartMs, findAppPid, isAppStale, openAppVerified, quitApp } from "../app-control.ts";
import type { BuildCtx } from "../BuildStep.ts";

export interface RelaunchPlan {
  action: "relaunch" | "open" | "none";
  reason: string;
}

function mtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

export interface UiActionInput {
  open: boolean;
  running: boolean;
  bundleStale: boolean;
}

export function decideUiAction(i: UiActionInput): RelaunchPlan {
  if (!i.running) {
    return i.open
      ? { action: "open", reason: "not running, --open" }
      : { action: "none", reason: "not running — next launch loads fresh" };
  }
  if (i.bundleStale) return { action: "relaunch", reason: "app bundle changed" };
  return { action: "none", reason: "running build is current" };
}

export async function deliverUi(
  ctx: BuildCtx,
  opts: { appApplied?: boolean },
): Promise<RelaunchPlan> {
  if (ctx.noApp) return { action: "none", reason: "--no-app" };
  // The caller drives its own reload (auto-update launch splash) — don't quit
  // or relaunch the app from here, just leave the freshly restarted daemon.
  if (ctx.noRelaunch) return { action: "none", reason: "--no-relaunch (caller drives reload)" };

  const pid = findAppPid();
  const running = pid !== null;
  const bundleStale =
    running &&
    isAppStale({
      running,
      appStartMs: appStartMs(pid),
      stampMtimes: [mtimeMs(APP_STAMP_PATH)].filter((n): n is number => n !== null),
    });

  if (ctx.dryRun) {
    // Predict without side effects — in a dry run build.sh never ran, so the
    // bundle stamp on disk is still the old one; appApplied stands in for it.
    if (running && (bundleStale || opts.appApplied)) {
      return { action: "relaunch", reason: "app bundle changed" };
    }
    return decideUiAction({ open: ctx.open, running, bundleStale });
  }

  return decideUiAction({ open: ctx.open, running, bundleStale });
}

export async function applyRelaunch(plan: RelaunchPlan): Promise<void> {
  if (plan.action !== "relaunch" && plan.action !== "open") return;
  if (plan.action === "relaunch") {
    const gone = await quitApp();
    if (!gone) throw new Error("Eos.app did not quit within 10s — close it manually and rerun");
  }
  await openAppVerified();
}
