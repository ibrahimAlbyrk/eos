// Shared daemon lifecycle helpers — used by `eos start`, `eos restart` and
// the build engine's daemon step, so the kill/spawn/wait mechanics can't
// drift between them. Extracted from restart.ts; behavior is unchanged.

import { execSync, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const ORPHAN_PATTERN = "manager/daemon.ts|spawner/worker.ts|orchestrator-mcp.ts|worker-mcp.ts|claude --settings";

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

export function spawnDaemonDetached(repoRoot: string): void {
  const child = spawn(
    "node",
    ["--no-warnings", "--experimental-strip-types", join(repoRoot, "manager", "daemon.ts")],
    { stdio: ["ignore", "ignore", "ignore"], detached: true },
  );
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
