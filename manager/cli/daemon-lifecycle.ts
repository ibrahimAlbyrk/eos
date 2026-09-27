// Shared daemon lifecycle helpers — used by `eos start`, `eos restart` and
// the build engine's daemon step, so the kill/spawn/wait mechanics can't
// drift between them. Extracted from restart.ts; behavior is unchanged.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { dirname, join } from "node:path";

import { rotateIfLarge } from "./log-rotate.ts";
import {
  DAEMON_LABEL, isLaunchAgentLoaded, launchAgentPid, startLaunchAgent, stopLaunchAgent,
} from "../../infra/src/daemon/launchd.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** How long start/restart/build wait for a freshly started daemon to answer. */
export const HEALTH_WAIT_MS = 30_000;
const HEALTH_POLL_MS = 50;

// Above both the daemon's own shutdown deadline (5s) and launchd's ExitTimeOut (10s).
const STOP_TIMEOUT_MS = 12_000;

const useLaunchd = process.platform === "darwin";

/** What a health probe could establish about the daemon. */
export type DaemonHealth =
  | { state: "up"; body: unknown }
  /** Nothing is listening — the daemon really is down. */
  | { state: "down" }
  /** The probe itself could not be made, so daemon state is UNKNOWN. Seen when
   *  the machine has no ephemeral port left (every connect dies instantly with
   *  EADDRNOTAVAIL) or the fd limit is hit. Treating this as "down" is what used
   *  to start a second daemon on top of a healthy one. */
  | { state: "unreachable"; code: string };

/** Innermost error code of a failed fetch (undici nests the real error in .cause). */
function errorCode(e: unknown): string {
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string") return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return "";
}

/** Codes that mean "the local network stack refused to even try". */
const EXHAUSTION_CODES = new Set(["EADDRNOTAVAIL", "EMFILE", "ENFILE", "EADDRINUSE"]);

function socketHealth(socketPath: string): Promise<DaemonHealth | null> {
  return new Promise((resolve) => {
    const req = request({ socketPath, path: "/health", method: "GET", timeout: 2000 }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => { text += c; });
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          let body: unknown = {};
          try { body = JSON.parse(text); } catch {}
          resolve({ state: "up", body });
        } else resolve(null);
      });
    });
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
    req.end();
  });
}

/**
 * Is the daemon up? Asks over the unix socket FIRST — a UDS probe needs no
 * ephemeral port, so it still answers on a machine whose port range is
 * saturated, which is exactly when the TCP answer is useless.
 */
export async function probeDaemon(daemonUrl: string, socketPath?: string): Promise<DaemonHealth> {
  if (socketPath && existsSync(socketPath)) {
    const viaSocket = await socketHealth(socketPath);
    if (viaSocket) return viaSocket;
  }
  try {
    const r = await fetch(`${daemonUrl}/health`);
    if (r.ok) return { state: "up", body: await r.json().catch(() => ({})) };
    return { state: "down" };
  } catch (e) {
    const code = errorCode(e);
    if (EXHAUSTION_CODES.has(code)) return { state: "unreachable", code };
    return { state: "down" };
  }
}

/** True when the pid in `pidFile` names a live process. */
export function daemonPidAlive(pidFile: string): number | null {
  if (!existsSync(pidFile)) return null;
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  if (!pid || isNaN(pid)) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

/** Operator-facing explanation for an `unreachable` probe. */
export function unreachableHint(code: string): string {
  if (code === "EADDRNOTAVAIL") {
    return "cannot open a local connection: the machine has no ephemeral port left "
      + "(every port in net.inet.ip.portrange is stuck in TIME_WAIT). The daemon may well be "
      + "running — this probe could not reach it. Free the range with "
      + "`sudo sysctl -w net.inet.tcp.msl=1000` (TIME_WAIT 30s -> 2s), then retry; "
      + "run `eos doctor` for the current count.";
  }
  if (code === "EMFILE" || code === "ENFILE") {
    return "cannot open a socket: this process is out of file descriptors (raise with `ulimit -n`).";
  }
  return `cannot open a local connection (${code}).`;
}

function isDaemonProcess(pid: number): boolean {
  try {
    const cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
    return /manager\/daemon\.ts|daemon\.bundle\.mjs/.test(cmd);
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const giveUpAt = Date.now() + timeoutMs;
  while (Date.now() < giveUpAt) {
    try { process.kill(pid, 0); } catch { return true; }
    await sleep(100);
  }
  return false;
}

/** SIGTERM, wait for the graceful shutdown, then SIGKILL the process group. A
 *  detached daemon leads its own group, so that takes down a hung leader plus any
 *  children it left behind (SDK claude, MCP servers) — and nothing else. */
async function stopProcessGroup(pid: number): Promise<void> {
  try { process.kill(pid, "SIGTERM"); } catch { return; }
  const exited = await waitForExit(pid, STOP_TIMEOUT_MS);
  try { process.kill(-pid, "SIGKILL"); } catch {}
  if (!exited) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  console.log(`stopped daemon pid=${pid}${exited ? "" : " (forced)"}`);
}

/** Stops the daemon and waits until it is really gone (ports released).
 *  Returns false when no daemon was running. */
export async function stopDaemon(pidFile: string): Promise<boolean> {
  let found = false;
  if (useLaunchd && isLaunchAgentLoaded(DAEMON_LABEL)) {
    found = true;
    const pid = launchAgentPid(DAEMON_LABEL);
    const stopped = await stopLaunchAgent(DAEMON_LABEL, STOP_TIMEOUT_MS);
    console.log(stopped ? `stopped daemon${pid ? ` pid=${pid}` : ""}` : "daemon did not stop in time");
  }
  // A daemon started outside launchd: an older eos build, or `eos start -f`.
  const pid = daemonPidAlive(pidFile);
  if (pid && isDaemonProcess(pid)) {
    found = true;
    await stopProcessGroup(pid);
  }
  try { rmSync(pidFile, { force: true }); } catch {}
  return found;
}

function daemonCommand(repoRoot: string): string {
  // Run under bash to lift the fd soft limit to the hard ceiling BEFORE node
  // starts: the macOS GUI default soft limit is 256, far too low for a process
  // supervising many PTYs + git/file watches — exhausting it breaks ALL
  // child_process spawns (git probes, new workers) with EBADF/EMFILE. Raise soft
  // to hard (the real cap is kern.maxfilesperproc, ~61440) instead of a fixed
  // number so large checkouts don't hit a low ceiling; lifting soft up to hard
  // never fails. --max-old-space-size: runaway guard (~80MB baseline; 1024 caps a leak).
  const entry = join(repoRoot, "manager", "daemon.ts");
  return `ulimit -Sn "$(ulimit -Hn)" 2>/dev/null; exec node --max-old-space-size=1024 --no-warnings --experimental-strip-types ${JSON.stringify(entry)}`;
}

/** Starts the daemon in the background: a launchd agent on macOS (crash restart,
 *  group reaping), a detached child elsewhere. */
export async function startDaemon(opts: { repoRoot: string; eosHome: string; logPath: string }): Promise<void> {
  // Rotate before the new daemon inherits the fd — the only moment nobody holds
  // an append offset into the file.
  try {
    mkdirSync(dirname(opts.logPath), { recursive: true });
    rotateIfLarge(opts.logPath);
  } catch {}
  const cmd = daemonCommand(opts.repoRoot);
  if (useLaunchd) {
    await startLaunchAgent({
      label: DAEMON_LABEL,
      plistPath: join(opts.eosHome, "daemon.plist"),
      programArguments: ["/bin/bash", "-c", cmd],
      env: process.env,
      logPath: opts.logPath,
    }, STOP_TIMEOUT_MS);
    return;
  }
  // Capture stdout/stderr to the log instead of /dev/null — the daemon's
  // StructLogger writes there, so otherwise every line is discarded.
  let out: number | "ignore" = "ignore";
  try { out = openSync(opts.logPath, "a"); } catch {}
  spawn("/bin/bash", ["-c", cmd], { stdio: ["ignore", out, out], detached: true }).unref();
}

/**
 * Polls /health — at once, then every 50ms, since a fresh daemon listens within
 * ~150ms — until it answers or `timeoutMs` passes. Returns the probe result so
 * the caller can tell "the daemon never came up" (down) apart from "this machine
 * cannot make a local connection at all" (unreachable) — reporting the latter as
 * a failed start sent operators hunting a daemon bug that was never there.
 */
export async function waitHealthy(daemonUrl: string, timeoutMs: number, socketPath?: string): Promise<DaemonHealth> {
  const giveUpAt = Date.now() + timeoutMs;
  for (;;) {
    const last = await probeDaemon(daemonUrl, socketPath);
    // "unreachable" will not un-block by polling harder; report it now.
    if (last.state !== "down" || Date.now() >= giveUpAt) return last;
    await sleep(HEALTH_POLL_MS);
  }
}
