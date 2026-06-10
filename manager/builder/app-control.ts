// Eos.app process control + the staleness predicate. A closed app can never
// be stale — main.swift clears HTTP caches and reloads /web/ with
// reloadIgnoringLocalCacheData on every launch — so only a RUNNING instance
// that started before the newest artifact stamp needs a relaunch.

import { execFileSync } from "node:child_process";

export const APP_BUNDLE = "/Applications/Eos.app";
export const APP_BUNDLE_ID = "com.ibrahimalbyrk.eos";
export const APP_STAMP_PATH = `${APP_BUNDLE}/Contents/Resources/.eos-stamp`;
const APP_BINARY = `${APP_BUNDLE}/Contents/MacOS/Eos`;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function findAppPid(): number | null {
  try {
    const out = execFileSync("pgrep", ["-f", APP_BINARY], { encoding: "utf8" }).trim();
    const pid = Number(out.split("\n")[0]);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

// ps etime is locale-free ([[dd-]hh:]mm:ss), unlike lstart. Returns ms.
export function parseEtime(s: string): number | null {
  const m = s.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  const [, dd, hh, mm, ss] = m;
  return (((Number(dd ?? 0) * 24 + Number(hh ?? 0)) * 60 + Number(mm)) * 60 + Number(ss)) * 1000;
}

export function appStartMs(pid: number): number | null {
  try {
    const etime = parseEtime(execFileSync("ps", ["-p", String(pid), "-o", "etime="], { encoding: "utf8" }));
    return etime === null ? null : Date.now() - etime;
  } catch {
    return null;
  }
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
  try {
    execFileSync("osascript", ["-e", `tell application id "${APP_BUNDLE_ID}" to quit`], { stdio: "ignore" });
  } catch {
    // app may have no AppleScript handler ready; fall through to the poll
  }
  for (let i = 0; i < 40; i++) {
    if (findAppPid() === null) return true;
    await sleep(250);
  }
  return false;
}

export function openApp(): void {
  execFileSync("open", ["-a", APP_BUNDLE], { stdio: "ignore" });
}
