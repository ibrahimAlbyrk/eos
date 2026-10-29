import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { UPDATE_FILES, type UpdateApply } from "../../../../../contracts/src/update";
import { DAEMON_LABEL, stopLaunchAgent } from "../../../../../infra/src/daemon/launchd";
import type { PendingApply } from "../../../updater/apply";
import { eosHome } from "../../daemon";
import { DAEMON_STOP_TIMEOUT_MS } from "./launch";

// The new version's first launch includes starting its daemon (up to 40 s).
const BOOT_TIMEOUT_MS = 120_000;

// Stops the daemon (agents suspend, as with Rebuild), leaves apply.json for the
// applier and starts it detached; the caller quits right after. The applier runs
// from a copy outside app.asar — it is plain Node, and the bundle is about to move.
export async function startMacUpdate(apply: UpdateApply, dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const pending: PendingApply = {
    ...apply,
    dir,
    appPid: process.pid,
    daemonLabel: DAEMON_LABEL,
    uid: process.getuid?.() ?? 0,
    bootTimeoutMs: BOOT_TIMEOUT_MS,
    log: path.join(eosHome(), "logs", "app-update.log"),
  };
  const pendingPath = path.join(dir, UPDATE_FILES.pending);
  writeFileSync(pendingPath, JSON.stringify(pending));
  const script = path.join(dir, "apply.cjs");
  copyFileSync(path.join(__dirname, "apply.js"), script);

  await stopLaunchAgent(DAEMON_LABEL, DAEMON_STOP_TIMEOUT_MS);
  spawn(process.execPath, [script, pendingPath], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  }).unref();
}
