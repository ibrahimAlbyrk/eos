// Eos.app process control + the staleness predicate. A closed app can never
// be stale — main.swift loads the bundled UI fresh from eos://app/ on every
// launch — so only a RUNNING instance that started before the newest artifact
// stamp needs a relaunch.

import { spawnSync } from "node:child_process";

export const APP_BUNDLE = "/Applications/Eos.app";
export const APP_BUNDLE_ID = "com.ibrahimalbyrk.eos";
export const APP_STAMP_PATH = `${APP_BUNDLE}/Contents/Resources/.eos-stamp`;
const APP_BINARY = `${APP_BUNDLE}/Contents/MacOS/Eos`;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function findAppPid(): number | null {
  const r = spawnSync("pgrep", ["-f", APP_BINARY], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const pid = Number(r.stdout.trim().split("\n")[0]);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

// LaunchServices keeps a terminating app registered ~40ms past process exit
// (measured); open(1) in that window fails with -600 procNotFound. So
// "really gone" = process gone AND LS deregistered.
function lsRegistered(): boolean {
  const r = spawnSync("lsappinfo", ["info", "-app", APP_BUNDLE_ID], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim().length > 0;
}

// ps etime is locale-free ([[dd-]hh:]mm:ss), unlike lstart. Returns ms.
export function parseEtime(s: string): number | null {
  const m = s.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  const [, dd, hh, mm, ss] = m;
  return (((Number(dd ?? 0) * 24 + Number(hh ?? 0)) * 60 + Number(mm)) * 60 + Number(ss)) * 1000;
}

export function appStartMs(pid: number): number | null {
  const r = spawnSync("ps", ["-p", String(pid), "-o", "etime="], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const etime = parseEtime(r.stdout);
  return etime === null ? null : Date.now() - etime;
}

export interface AppStaleInput {
  running: boolean;
  appStartMs: number | null;
  stampMtimes: number[];
}

// The 1s slack absorbs etime's second granularity in the safe direction:
// an app relaunched moments after a stamp write must not read as stale again
// (that would relaunch on every run).
export function isAppStale(input: AppStaleInput): boolean {
  if (!input.running) return false;
  const newest = Math.max(0, ...input.stampMtimes);
  if (newest === 0) return false;
  if (input.appStartMs === null) return true;
  return input.appStartMs + 1000 < newest;
}

export async function quitApp(): Promise<boolean> {
  const r = spawnSync("osascript", ["-e", `tell application id "${APP_BUNDLE_ID}" to quit`], {
    encoding: "utf8",
  });
  if (r.status !== 0) {
    // No early return: the poll below still decides — the app may be gone
    // already, or quit by other means.
    console.error(`osascript quit: ${(r.stderr || "").trim() || `exit ${r.status}`}`);
  }
  for (let i = 0; i < 80; i++) {
    if (findAppPid() === null && !lsRegistered()) {
      await sleep(150);
      return true;
    }
    await sleep(125);
  }
  return false;
}

async function waitForAppPid(timeoutMs: number): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = findAppPid();
    if (pid !== null) return pid;
    await sleep(100);
  }
  return null;
}

// Verified launch, same philosophy as the rest of the pipeline: open must
// yield a process that survives a grace period. Transient LaunchServices
// failures (-600 under load) get a bounded retry, and the real stderr
// surfaces in the failure message instead of being swallowed.
export async function openAppVerified(): Promise<void> {
  const attempts = 3;
  let lastDetail = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const r = spawnSync("open", ["-a", APP_BUNDLE], { encoding: "utf8" });
    if (r.status === 0) {
      const pid = await waitForAppPid(3000);
      if (pid !== null) {
        await sleep(1500);
        if (findAppPid() !== null) return;
        lastDetail = "app exited right after launch";
      } else {
        lastDetail = "no app process appeared within 3s";
      }
    } else {
      lastDetail = (r.stderr || r.stdout || `open exited ${r.status}`).trim();
    }
    if (attempt < attempts) await sleep(500 * attempt);
  }
  throw new Error(`could not launch Eos.app after ${attempts} attempts — ${lastDetail}`);
}
