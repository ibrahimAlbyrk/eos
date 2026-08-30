import { app } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync, renameSync, rmSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { homedir } from "node:os";
import path from "node:path";

export interface Health {
  ok: boolean;
  pid?: number;
  sourceStamp?: string;
}

const HEX_RE = /^[0-9a-f]+$/;

// The only secret: a per-boot token the daemon writes as plaintext to
// ~/.eos/ui-token (doc 10 §e — no Keychain, the daemon owns this file's
// lifecycle). Validate lowercase hex like the Swift shell does.
export async function readUiToken(): Promise<string> {
  const file = path.join(homedir(), ".eos", "ui-token");
  const raw = (await readFile(file, "utf8")).trim();
  if (!HEX_RE.test(raw)) {
    throw new Error(`~/.eos/ui-token is not lowercase hex (${raw.length} chars)`);
  }
  return raw;
}

// ── ~/.eos paths ─────────────────────────────────────────────────────────────
export function eosHome(): string {
  return path.join(homedir(), ".eos");
}
export function daemonSocketPath(): string {
  return path.join(eosHome(), "daemon.sock");
}
export function daemonLogPath(): string {
  return path.join(eosHome(), "logs", "daemon.log");
}
// Dev: app.getAppPath() is the app/ package dir, so the repo root is its parent
// and the daemon entry is <repoRoot>/manager/daemon.ts (exactly how the Swift app
// and `eos start` launch it). PACKAGED: there is no repo — the daemon bundle +
// prompts + worker templates are shipped under process.resourcesPath, which
// becomes the "repo root" the daemon's config resolves paths against.
export function resolveRepoRoot(): string {
  return app.isPackaged ? process.resourcesPath : path.dirname(app.getAppPath());
}

// ── Daemon lifecycle ─────────────────────────────────────────────────────────
// probeDaemon / waitHealthy / spawnDaemon are REPLICATED from
// manager/cli/daemon-lifecycle.ts (the proven `eos start`/`eos restart`
// mechanism). They are replicated, not imported, because that module uses
// .ts-extension import specifiers + manager's TS config, which the app's tsc
// (moduleResolution "Bundler", no allowImportingTsExtensions, include:["src"])
// rejects. The socket-first probe, the up/down/unreachable classification, and
// the spawn command (fd-bump + node flags) are kept BYTE-IDENTICAL to the source
// — keep them in sync if that file changes.

/** What a health probe could establish about the daemon. */
export type DaemonHealth =
  | { state: "up"; body: unknown }
  | { state: "down" }
  /** The probe itself could not be made (no ephemeral port / fd exhaustion), so
   *  daemon state is UNKNOWN. Treating this as "down" is what would start a
   *  second daemon on top of a healthy one — so we never spawn on this. */
  | { state: "unreachable"; code: string };

/** Codes that mean "the local network stack refused to even try". */
const EXHAUSTION_CODES = new Set(["EADDRNOTAVAIL", "EMFILE", "ENFILE", "EADDRINUSE"]);

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

/**
 * Polls /health every 250ms until the daemon answers. Returns the probe result so
 * the caller can tell "the daemon never came up" (down) apart from "this machine
 * cannot make a local connection at all" (unreachable).
 */
export async function waitHealthy(daemonUrl: string, tries: number, socketPath?: string): Promise<DaemonHealth> {
  let last: DaemonHealth = { state: "down" };
  for (let i = 0; i < tries; i++) {
    await delay(250);
    last = await probeDaemon(daemonUrl, socketPath);
    if (last.state === "up") return last;
    // A blocked probe will not un-block by polling harder; report it now.
    if (last.state === "unreachable") return last;
  }
  return last;
}

/** Operator-facing explanation for an `unreachable` probe (from daemon-lifecycle.ts). */
export function unreachableHint(code: string): string {
  if (code === "EADDRNOTAVAIL") {
    return "The machine has no ephemeral port left (net.inet.ip.portrange saturated with "
      + "TIME_WAIT sockets). A daemon may well be running — this probe could not reach it. "
      + "Free the range with `sudo sysctl -w net.inet.tcp.msl=1000`, then retry.";
  }
  if (code === "EMFILE" || code === "ENFILE") {
    return "Out of file descriptors (raise with `ulimit -n`), then retry.";
  }
  return `Cannot open a local connection (${code}).`;
}

// Rotate the daemon log if it has grown past the cap, BEFORE the new daemon
// inherits the append fd — the only moment nobody holds an offset into it
// (replicated from manager/cli/log-rotate.ts; prevents unbounded growth).
const DAEMON_LOG_MAX_BYTES = 64 * 1024 * 1024;
const DAEMON_LOG_KEEP = 3;
function rotateDaemonLog(logPath: string): void {
  try {
    if (statSync(logPath).size < DAEMON_LOG_MAX_BYTES) return;
  } catch {
    return; // absent → nothing to rotate
  }
  try { rmSync(`${logPath}.${DAEMON_LOG_KEEP}`, { force: true }); } catch {}
  for (let i = DAEMON_LOG_KEEP - 1; i >= 1; i--) {
    try { renameSync(`${logPath}.${i}`, `${logPath}.${i + 1}`); } catch {}
  }
  try { renameSync(logPath, `${logPath}.1`); } catch {}
}

/**
 * Spawn the daemon detached, EXACTLY as manager/cli/daemon-lifecycle.ts does, and
 * return the child so the app can SIGTERM only this pid on quit. Runs under bash
 * to lift the fd soft limit to the hard ceiling before node starts (the macOS GUI
 * default of 256 is far too low for a process supervising many PTYs + watches);
 * the ulimit + node flags are kept byte-identical to the source. Only difference:
 * this returns the child and does not unref() it, so the app can track + stop it.
 */
export function spawnDaemon(repoRoot: string, logPath?: string): ChildProcess {
  let out: number | "ignore" = "ignore";
  if (logPath) {
    try {
      mkdirSync(path.dirname(logPath), { recursive: true });
      rotateDaemonLog(logPath);
      out = openSync(logPath, "a");
    } catch {
      out = "ignore";
    }
  }
  // PACKAGED: run the shipped daemon BUNDLE off Electron's own Node
  // (process.execPath + ELECTRON_RUN_AS_NODE=1) — no repo, no system node/bun.
  // The EOS_* env points the daemon (and every subprocess it spawns) at the
  // shipped bundles + node_modules + prompts + worker templates under Resources.
  // NODE_OPTIONS carries the memory cap (ELECTRON_RUN_AS_NODE honors it).
  if (app.isPackaged) {
    const resources = process.resourcesPath;
    const bundlesDir = path.join(resources, "daemon");
    const entry = path.join(bundlesDir, "daemon.bundle.mjs");
    // arm64-only for now (Stage 3 decision); universal later.
    const claudeBin = path.join(
      bundlesDir, "node_modules", "@anthropic-ai", "claude-agent-sdk-darwin-arm64", "claude",
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      NODE_OPTIONS: `--max-old-space-size=1024 --no-warnings ${process.env.NODE_OPTIONS ?? ""}`.trim(),
      EOS_PACKAGED: "1",
      EOS_BUNDLES_DIR: bundlesDir,
      EOS_REPO_ROOT: resources,
      EOS_PROMPTS_DIR: path.join(resources, "prompts"),
      EOS_WORKER_DEFINITIONS_DIR: path.join(resources, "workers"),
      EOS_CLAUDE_BIN: claudeBin,
    };
    const cmd = `ulimit -Sn "$(ulimit -Hn)" 2>/dev/null; exec ${JSON.stringify(process.execPath)} ${JSON.stringify(entry)}`;
    return spawn("/bin/bash", ["-c", cmd], {
      stdio: ["ignore", out, out],
      detached: true,
      env,
    });
  }

  // DEV: system node + strip-types against the repo .ts (unchanged).
  const entry = path.join(repoRoot, "manager", "daemon.ts");
  const cmd = `ulimit -Sn "$(ulimit -Hn)" 2>/dev/null; exec node --max-old-space-size=1024 --no-warnings --experimental-strip-types ${JSON.stringify(entry)}`;
  return spawn("/bin/bash", ["-c", cmd], {
    stdio: ["ignore", out, out],
    detached: true,
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
