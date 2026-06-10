// Deploy epilogue, not a BuildStep: the app is not an artifact to build but a
// running instance to refresh. Closed app = fresh by design (see app-control).

import { statSync } from "node:fs";

import { APP_STAMP_PATH, appStartMs, findAppPid, isAppStale, openApp, quitApp } from "../app-control.ts";
import type { BuildCtx } from "../BuildStep.ts";
import { webDistStampPath } from "./web.ts";

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

export function relaunchPlan(ctx: BuildCtx): RelaunchPlan {
  if (ctx.noApp) return { action: "none", reason: "--no-app" };
  const pid = findAppPid();
  if (pid === null) {
    return ctx.open
      ? { action: "open", reason: "not running, --open" }
      : { action: "none", reason: "not running — next launch loads fresh" };
  }
  const stampMtimes = [mtimeMs(webDistStampPath(ctx.repoRoot)), mtimeMs(APP_STAMP_PATH)].filter(
    (n): n is number => n !== null,
  );
  const stale = isAppStale({ running: true, appStartMs: appStartMs(pid), stampMtimes });
  return stale
    ? { action: "relaunch", reason: "started before newest build" }
    : { action: "none", reason: "running build is current" };
}

export async function applyRelaunch(plan: RelaunchPlan): Promise<void> {
  if (plan.action === "none") return;
  if (plan.action === "relaunch") {
    const gone = await quitApp();
    if (!gone) throw new Error("Eos.app did not quit within 10s — close it manually and rerun");
  }
  openApp();
}
