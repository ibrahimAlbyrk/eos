import { spawn, execFile, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import type { DaemonLaunch } from "../../daemon";

// Windows has no launchd: the app supervises its daemon itself. Restarted after
// a crash (a few times, then left down so a broken build doesn't spin), the
// whole process tree ended on stop. Detached, so a crashed app leaves it running
// for the next launch to adopt.
const MAX_RESTARTS = 5;
const RESTART_DELAY_MS = 1_000;

let child: ChildProcess | null = null;
let stopping = false;
let restarts = 0;

function run(launch: DaemonLaunch, logPath: string): void {
  const log = openSync(logPath, "a");
  const proc = spawn(launch.program, launch.args, { env: launch.env, detached: true, windowsHide: true, stdio: ["ignore", log, log] });
  closeSync(log);
  proc.unref();
  child = proc;
  proc.once("exit", (code) => {
    if (child === proc) child = null;
    if (stopping || code === 0 || restarts >= MAX_RESTARTS) return;
    restarts++;
    setTimeout(() => { if (!stopping) run(launch, logPath); }, RESTART_DELAY_MS);
  });
}

export async function startSupervisedDaemon(launch: DaemonLaunch, logPath: string): Promise<void> {
  stopping = false;
  restarts = 0;
  run(launch, logPath);
}

export function stopSupervisedDaemon(): void {
  stopping = true;
  const pid = child?.pid;
  child = null;
  // /T ends the daemon's children too (claude, bun, codex) — launchd's process-group reap.
  if (pid) execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
}
