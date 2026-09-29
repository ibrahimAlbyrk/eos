import { app, dialog, shell } from "electron";
import { execFile } from "node:child_process";
import { cp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const SAVER = "Eos.saver";

// Packaged: shipped under Contents/Resources. Dev: built by scripts/build-saver.mjs.
function bundledSaverPath(): string {
  return app.isPackaged ? path.join(process.resourcesPath, SAVER) : path.join(app.getAppPath(), ".forge-build", SAVER);
}

// macOS 26+ folded the Screen Saver pane into Wallpaper (as a "Screen Saver…"
// sheet with no deep link); an unknown pane id silently opens General instead.
function screenSaverSettingsUrl(): string {
  const major = Number(process.getSystemVersion().split(".")[0]);
  const pane = major >= 26 ? "com.apple.Wallpaper-Settings.extension" : "com.apple.ScreenSaver-Settings.extension";
  return `x-apple.systempreferences:${pane}`;
}

// Copies the saver into ~/Library/Screen Savers (replacing an older copy), then
// opens the settings pane — macOS has no supported way to select a saver
// programmatically, so picking "Eos" there is the user's one step.
export async function installScreenSaver(): Promise<void> {
  try {
    const dest = path.join(homedir(), "Library", "Screen Savers", SAVER);
    await rm(dest, { recursive: true, force: true });
    await cp(bundledSaverPath(), dest, { recursive: true });
    await shell.openExternal(screenSaverSettingsUrl());
  } catch (e) {
    dialog.showErrorBox("Couldn’t install the Eos screen saver", e instanceof Error ? e.message : String(e));
  }
}

// Asks loginwindow's screen-saver daemon (the one behind the idle timer) to start
// the saver, so it runs on every display. `open -a ScreenSaverEngine` runs the
// engine in its own process instead, which shows the saver on one display only.
const START_SCREEN_SAVER = 'ObjC.import("ScreenSaver"); $.ScreenSaverController.controller.screenSaverStartNow';

// Starts the screen saver now. With "Require password immediately" set in Lock
// Screen settings this is a real lock; the Mac itself stays awake for the phone.
export function lockScreen(): void {
  execFile("/usr/bin/osascript", ["-l", "JavaScript", "-e", START_SCREEN_SAVER]);
}
