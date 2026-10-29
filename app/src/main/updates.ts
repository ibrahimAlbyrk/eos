// The shell's side of in-app updates (docs/updates/00-UPDATES-PLAN.md). The
// daemon announces a verified staged version on bus topic update:apply; this
// shows the restart splash, lets the platform stop the daemon and start the
// applier, and quits. Once a new version is up, it tells the waiting applier
// (boot-ok) so the applier keeps it instead of going back. Eos opening and the
// Mac waking up ask the daemon to look for a new version.

import { app, dialog } from "electron";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { UPDATE_FILES, UpdateApplySchema, type UpdateCheckTrigger } from "../../../contracts/src/update";
import { eosHome } from "./daemon";
import { shellPlatform } from "./platform";
import { createSplash } from "./splash";

let applying = false;

function updatesDir(): string {
  return path.join(eosHome(), "updates");
}

export async function applyUpdate(payload: unknown, quit: () => void): Promise<void> {
  const apply = UpdateApplySchema.safeParse(payload);
  if (!apply.success || applying || !shellPlatform.applyUpdate) return;
  applying = true;
  const splash = createSplash(`Updating · ${apply.data.from} → ${apply.data.version}`);
  try {
    await shellPlatform.applyUpdate(apply.data, updatesDir());
    quit();
  } catch (e) {
    applying = false;
    if (!splash.isDestroyed()) splash.close();
    void dialog.showMessageBox({
      type: "error",
      message: "Eos couldn't restart to update",
      detail: e instanceof Error ? e.message : String(e),
    });
  }
}

export function markUpdateBooted(): void {
  const dir = updatesDir();
  if (!existsSync(path.join(dir, UPDATE_FILES.pending))) return;
  writeFileSync(path.join(dir, UPDATE_FILES.bootOk), JSON.stringify({ version: app.getVersion() }));
}

// The daemon skips it when it looked a few minutes ago; a daemon that isn't up
// yet just misses it (its own first check follows its start).
export function nudgeUpdateCheck(daemonUrl: string, token: string, trigger: Exclude<UpdateCheckTrigger, "manual">): void {
  // ROUTES.updateCheck (contracts/src/http.ts, not bundled into the shell).
  void fetch(`${daemonUrl}/api/update/check`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-eos-ui-token": token },
    body: JSON.stringify({ trigger }),
  }).catch(() => {});
}
