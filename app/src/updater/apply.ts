// The in-app update applier (macOS). Runs detached, as plain Node (the old app's
// own binary with ELECTRON_RUN_AS_NODE), after the app has stopped its daemon
// and quit: puts the installed Eos.app aside, renames the verified staged copy
// into its place and opens it. If the new version doesn't report in (it writes
// the boot-ok marker once its daemon answers and its window is up), the old app
// goes back and opens instead. Either way result.json says how it ended, for
// the daemon to show. It never deletes the app it set aside until the next update.
//
// Usage: <Eos binary> apply.cjs <apply.json>  (written by main/updates.ts)

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { UPDATE_FILES } from "../../../contracts/src/update";

export interface PendingApply {
  version: string;
  from: string;
  staged: string;
  target: string;
  // ~/.eos/updates
  dir: string;
  appPid: number;
  daemonLabel: string;
  uid: number;
  bootTimeoutMs: number;
  log: string;
}

function main(): void {
  const pending = JSON.parse(readFileSync(process.argv[2], "utf8")) as PendingApply;
  const log = (msg: string): void => {
    try { appendFileSync(pending.log, `${new Date().toISOString()} ${msg}\n`); } catch { /* no log, no matter */ }
  };
  log(`apply ${pending.from} → ${pending.version}`);

  waitForExit(pending.appPid, 30_000);
  bootout(pending);

  const previous = join(pending.dir, "previous", basename(pending.target));
  rmSync(dirname(previous), { recursive: true, force: true });
  mkdirSync(dirname(previous), { recursive: true });
  try {
    renameSync(pending.target, previous);
  } catch (e) {
    log(`could not set the installed app aside: ${message(e)}`);
    finish(pending, "rolled-back", log);
    open(pending.target, log);
    return;
  }
  try {
    renameSync(pending.staged, pending.target);
  } catch (e) {
    log(`could not move the new version in: ${message(e)}`);
    renameSync(previous, pending.target);
    finish(pending, "rolled-back", log);
    open(pending.target, log);
    return;
  }

  rmSync(join(pending.dir, UPDATE_FILES.bootOk), { force: true });
  open(pending.target, log);
  if (waitForBoot(pending)) {
    log(`${pending.version} is up`);
    finish(pending, "updated", log);
    return;
  }

  log(`${pending.version} did not come up in ${pending.bootTimeoutMs} ms — going back to ${pending.from}`);
  bootout(pending);
  stopEverythingIn(pending.target, log);
  const failed = join(pending.dir, `failed-${pending.version}.app`);
  rmSync(failed, { recursive: true, force: true });
  renameSync(pending.target, failed);
  renameSync(previous, pending.target);
  rmSync(failed, { recursive: true, force: true });
  finish(pending, "rolled-back", log);
  open(pending.target, log);
}

function finish(pending: PendingApply, kind: "updated" | "rolled-back", log: (m: string) => void): void {
  writeFileSync(join(pending.dir, UPDATE_FILES.result), JSON.stringify({ kind, version: pending.version, from: pending.from }));
  rmSync(join(pending.dir, UPDATE_FILES.pending), { force: true });
  log(`done: ${kind}`);
}

function waitForExit(pid: number, timeoutMs: number): void {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    sleep(200);
  }
}

function waitForBoot(pending: PendingApply): boolean {
  const marker = join(pending.dir, UPDATE_FILES.bootOk);
  const until = Date.now() + pending.bootTimeoutMs;
  while (Date.now() < until) {
    if (existsSync(marker)) {
      try {
        if ((JSON.parse(readFileSync(marker, "utf8")) as { version?: string }).version === pending.version) return true;
      } catch { /* half-written; look again */ }
    }
    sleep(500);
  }
  return false;
}

// launchd would restart the daemon from the bundle being moved.
function bootout(pending: PendingApply): void {
  try {
    execFileSync("launchctl", ["bootout", `gui/${pending.uid}/${pending.daemonLabel}`], { stdio: "ignore" });
  } catch { /* not loaded */ }
}

// Everything still running from the failed bundle: its app, helpers, daemon and
// agents — but not this applier, whose own command line names the same path.
function stopEverythingIn(bundle: string, log: (m: string) => void): void {
  let pids: number[] = [];
  try {
    pids = execFileSync("pgrep", ["-f", `${bundle}/Contents/`], { encoding: "utf8" })
      .split("\n").map(Number).filter((pid) => pid > 0 && pid !== process.pid && pid !== process.ppid);
  } catch { /* none */ }
  for (const pid of pids) {
    try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  }
  if (pids.length) log(`stopped ${pids.length} processes of the failed version`);
  sleep(500);
}

function open(app: string, log: (m: string) => void): void {
  try {
    execFileSync("open", [app]);
  } catch (e) {
    log(`could not open ${app}: ${message(e)}`);
  }
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

main();
