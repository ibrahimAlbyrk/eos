// Shared daemon lifecycle helpers — used by `eos start`, `eos restart` and
// the build engine's daemon step, so the kill/spawn/wait mechanics can't
// drift between them. Extracted from restart.ts; behavior is unchanged.

import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { dirname, join } from "node:path";

import { rotateIfLarge } from "./log-rotate.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const ORPHAN_PATTERN = "manager/daemon.ts|spawner/worker.ts|orchestrator-mcp.ts|worker-mcp.ts|gateway/server.ts|claude --settings";

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

export async function stopDaemonAndOrphans(pidFile: string): Promise<void> {
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    if (pid && !isNaN(pid)) {
      try {
        process.kill(pid, "SIGTERM");
        console.log(`stopped daemon pid=${pid}`);
      } catch {}
    }
  }
  await sleep(1000);
  try {
    execSync(`pkill -9 -f "${ORPHAN_PATTERN}"`, { stdio: "ignore" });
  } catch {}
  await sleep(1000);
  try {
    rmSync(pidFile, { force: true });
  } catch {}
}

export function spawnDaemonDetached(repoRoot: string, logPath?: string): void {
  // Capture stdout/stderr to a log instead of /dev/null — the daemon's
  // StructLogger writes there, so otherwise every line (including an EMFILE /
  // spawn storm) is discarded and the daemon's troubles are invisible.
  let out: number | "ignore" = "ignore";
  if (logPath) {
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      // Rotate before the new daemon inherits the fd — the only moment nobody
      // holds an append offset into the file.
      rotateIfLarge(logPath);
      out = openSync(logPath, "a");
    } catch {
      out = "ignore";
    }
  }
  // Run under bash to lift the fd soft limit to the hard ceiling BEFORE node
  // starts: the macOS GUI default soft limit is 256, far too low for a process
  // supervising many PTYs + git/file watches — exhausting it breaks ALL
  // child_process spawns (git probes, new workers) with EBADF/EMFILE. Raise soft
  // to hard (the real cap is kern.maxfilesperproc, ~61440) instead of a fixed
  // number so large checkouts don't hit a low ceiling; lifting soft up to hard
  // never fails. --max-old-space-size: runaway guard (~80MB baseline; 1024 caps a leak).
  const entry = join(repoRoot, "manager", "daemon.ts");
  const cmd = `ulimit -Sn "$(ulimit -Hn)" 2>/dev/null; exec node --max-old-space-size=1024 --no-warnings --experimental-strip-types ${JSON.stringify(entry)}`;
  const child = spawn("/bin/bash", ["-c", cmd], {
    stdio: ["ignore", out, out],
    detached: true,
  });
  child.unref();
}

/**
 * Polls /health every 250ms until the daemon answers. Returns the probe result so
 * the caller can tell "the daemon never came up" (down) apart from "this machine
 * cannot make a local connection at all" (unreachable) — reporting the latter as
 * a failed start sent operators hunting a daemon bug that was never there.
 */
export async function waitHealthy(daemonUrl: string, tries: number, socketPath?: string): Promise<DaemonHealth> {
  let last: DaemonHealth = { state: "down" };
  for (let i = 0; i < tries; i++) {
    await sleep(250);
    last = await probeDaemon(daemonUrl, socketPath);
    if (last.state === "up") return last;
    // A blocked probe will not un-block by polling harder; report it now.
    if (last.state === "unreachable") return last;
  }
  return last;
}
