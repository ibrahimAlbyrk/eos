import { app } from "electron";
import { spawn } from "node:child_process";
import path from "node:path";

// The Squirrel installer (Forge maker-squirrel) runs the app once per install
// event with a --squirrel-* flag: add the Start menu + desktop shortcuts on
// install, drop them on uninstall, then quit without showing anything.
// Returns true when this launch was such an event.
export function handleSquirrelEvent(): boolean {
  const event = process.argv[1];
  if (!event?.startsWith("--squirrel-")) return false;
  const updateExe = path.resolve(path.dirname(process.execPath), "..", "Update.exe");
  const exe = path.basename(process.execPath);
  const done = (): void => { app.quit(); };
  const update = (args: string[]): void => {
    spawn(updateExe, args, { detached: true }).once("close", done).once("error", done);
  };
  if (event === "--squirrel-install" || event === "--squirrel-updated") update(["--createShortcut", exe]);
  else if (event === "--squirrel-uninstall") update(["--removeShortcut", exe]);
  else done();
  return true;
}
