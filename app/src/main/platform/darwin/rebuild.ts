import { dialog, Notification, shell } from "electron";
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { eosHome } from "./daemon";

// `eos build --app` without a terminal. The build quits this app, stops its
// daemon and swaps /Applications/Eos.app, so it must outlive us: a detached
// child in its own session. A login shell gives it the user's PATH (eos, node,
// npm), which an app launched from the Dock doesn't have.
let building = false;

export async function rebuildAndRelaunch(busyAgents: number): Promise<void> {
  if (building) return;
  if (busyAgents > 0) {
    const { response } = await dialog.showMessageBox({
      type: "warning",
      message: "Rebuild and relaunch Eos?",
      detail: `${busyAgents} agent${busyAgents === 1 ? " is" : "s are"} working — Eos restarts its daemon, which suspends them.`,
      buttons: ["Rebuild", "Cancel"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) return;
  }
  building = true;

  const logPath = path.join(eosHome(), "logs", "app-build.log");
  mkdirSync(path.dirname(logPath), { recursive: true });
  const out = openSync(logPath, "w");
  const child = spawn(process.env.SHELL || "/bin/zsh", ["-lc", "eos build --app"], {
    cwd: homedir(),
    detached: true,
    stdio: ["ignore", out, out],
  });
  closeSync(out);
  child.unref();
  new Notification({ title: "Rebuilding Eos", body: "Eos relaunches when the build finishes." }).show();

  // Success never reaches us (the build quits this app first); a failure does.
  const failed = async (reason: string): Promise<void> => {
    building = false;
    const { response } = await dialog.showMessageBox({
      type: "error",
      message: "Eos rebuild failed",
      detail: `${reason}\n\nLog: ${logPath}`,
      buttons: ["Show Log", "OK"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) void shell.openPath(logPath);
  };
  child.on("error", (e) => void failed(e.message));
  child.on("exit", (code) => {
    if (code === 0) building = false;
    else void failed(`eos build --app exited with code ${code ?? "?"}`);
  });
}
