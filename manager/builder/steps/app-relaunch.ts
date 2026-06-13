// Deploy epilogue, not a BuildStep: the app is not an artifact to build but a
// running instance to refresh. Two delivery channels, cheapest first:
//   1. web dist changed → POST /api/ui-reload, the page reloads in place
//      (subscriber count is the delivery proof; 0 ⇒ fall back to relaunch)
//   2. app bundle changed (or reload reached nobody) → verified quit+open
// A closed app needs neither — it loads everything fresh on launch.

import { statSync } from "node:fs";

import { UiReloadResponseSchema } from "../../../contracts/src/http.ts";
import { APP_STAMP_PATH, appStartMs, findAppPid, isAppStale, openAppVerified, quitApp } from "../app-control.ts";
import type { BuildCtx } from "../BuildStep.ts";

export interface RelaunchPlan {
  action: "relaunch" | "open" | "reload" | "none";
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
  webApplied: boolean;
  /** SSE clients that received the reload broadcast; null = not attempted/unreachable. */
  reloadSubscribers: number | null;
}

export function decideUiAction(i: UiActionInput): RelaunchPlan {
  if (!i.running) {
    return i.open
      ? { action: "open", reason: "not running, --open" }
      : { action: "none", reason: "not running — next launch loads fresh" };
  }
  if (i.bundleStale) return { action: "relaunch", reason: "app bundle changed" };
  if (i.webApplied) {
    if ((i.reloadSubscribers ?? 0) > 0) {
      return { action: "none", reason: `ui reloaded in place (${i.reloadSubscribers} client${i.reloadSubscribers === 1 ? "" : "s"})` };
    }
    return { action: "relaunch", reason: "web rebuilt but no ui client took the reload" };
  }
  return { action: "none", reason: "running build is current" };
}

async function requestUiReload(daemonUrl: string): Promise<number | null> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 3000);
    const r = await fetch(`${daemonUrl}/api/ui-reload`, { method: "POST", signal: ctl.signal });
    clearTimeout(timer);
    if (!r.ok) return null;
    const parsed = UiReloadResponseSchema.safeParse(await r.json());
    return parsed.success ? parsed.data.subscribers : null;
  } catch {
    return null;
  }
}

export async function deliverUi(
  ctx: BuildCtx,
  opts: { webApplied: boolean; appApplied?: boolean },
): Promise<RelaunchPlan> {
  if (ctx.noApp) return { action: "none", reason: "--no-app" };
  // The caller drives its own reload (auto-update launch splash) — don't quit
  // or reload the app from here, just leave the freshly restarted daemon.
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
    // Predict without side effects — the reload broadcast WOULD reload pages.
    // appApplied stands in for bundleStale: the bundle stamp on disk is still
    // the old one in a dry run.
    if (running && (bundleStale || opts.appApplied)) {
      return { action: "relaunch", reason: "app bundle changed" };
    }
    if (opts.webApplied) return { action: "reload", reason: "web rebuilt — relaunch only if no ui client takes it" };
    return decideUiAction({ open: ctx.open, running, bundleStale, webApplied: false, reloadSubscribers: null });
  }

  const reloadSubscribers = opts.webApplied ? await requestUiReload(ctx.daemonUrl) : null;
  return decideUiAction({ open: ctx.open, running, bundleStale, webApplied: opts.webApplied, reloadSubscribers });
}

export async function applyRelaunch(plan: RelaunchPlan): Promise<void> {
  if (plan.action !== "relaunch" && plan.action !== "open") return;
  if (plan.action === "relaunch") {
    const gone = await quitApp();
    if (!gone) throw new Error("Eos.app did not quit within 10s — close it manually and rerun");
  }
  await openAppVerified();
}
