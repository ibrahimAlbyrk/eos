import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { UPDATE_FILES, type UpdateApply } from "../../../../../contracts/src/update";
import { eosHome } from "../../daemon";
import { stopSupervisedDaemon } from "./supervise";

// app/installer-win/src/install.rs UNINSTALLER — Eos Setup without its payload.
const UNINSTALLER = "Uninstall Eos.exe";
// Its own name keeps it out of the `taskkill /IM Eos.exe` it runs.
const APPLIER = "eos-apply.exe";
const BOOT_TIMEOUT_MS = 120_000;

// What Eos Setup's --apply reads (app/installer-win/src/update.rs Pending).
interface PendingApply extends UpdateApply {
  dir: string;
  bootTimeoutMs: number;
  log: string;
}

// Stops the daemon (agents suspend), leaves apply.json and starts Eos Setup's
// applier from outside the install folder — a running exe's folder can't be
// moved; the caller quits right after.
export async function startWindowsUpdate(apply: UpdateApply, dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const pending: PendingApply = { ...apply, dir, bootTimeoutMs: BOOT_TIMEOUT_MS, log: path.join(eosHome(), "logs", "app-update.log") };
  const pendingPath = path.join(dir, UPDATE_FILES.pending);
  writeFileSync(pendingPath, JSON.stringify(pending));
  const applier = path.join(dir, APPLIER);
  copyFileSync(path.join(apply.target, UNINSTALLER), applier);

  stopSupervisedDaemon();
  spawn(applier, ["--apply", pendingPath], { detached: true, stdio: "ignore", windowsHide: true }).unref();
}
