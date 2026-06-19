// Shared daemon lifecycle helpers — used by `eos start`, `eos restart` and
// the build engine's daemon step, so the kill/spawn/wait mechanics can't
// drift between them. Extracted from restart.ts; behavior is unchanged.

import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const ORPHAN_PATTERN = "manager/daemon.ts|spawner/worker.ts|orchestrator-mcp.ts|worker-mcp.ts|gateway/server.ts|claude --settings";

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
      out = openSync(logPath, "a");
    } catch {
      out = "ignore";
    }
  }
  // Run under bash so we can raise the fd soft limit first: the macOS GUI default
  // is 256, far too low for a process supervising many PTYs + git/file watches —
  // exhausting it breaks ALL child_process spawns (git probes, new workers).
  // --max-old-space-size: runaway guard (~80MB baseline; 1024 caps a leak).
  const entry = join(repoRoot, "manager", "daemon.ts");
  const cmd = `ulimit -n 10240 2>/dev/null; exec node --max-old-space-size=1024 --no-warnings --experimental-strip-types ${JSON.stringify(entry)}`;
  const child = spawn("/bin/bash", ["-c", cmd], {
    stdio: ["ignore", out, out],
    detached: true,
  });
  child.unref();
}

/** Polls /health every 250ms; resolves with the parsed body, or null after `tries`. */
export async function waitHealthy(daemonUrl: string, tries: number): Promise<unknown | null> {
  for (let i = 0; i < tries; i++) {
    await sleep(250);
    try {
      const r = await fetch(`${daemonUrl}/health`);
      if (r.ok) return await r.json().catch(() => ({}));
    } catch {}
  }
  return null;
}
