// Windows.

import { app } from "electron";
import path from "node:path";
import { copiedFilePaths } from "./win32/clipboard";
import { startSupervisedDaemon, stopSupervisedDaemon } from "./win32/supervise";
import { startWindowsUpdate } from "./win32/update";
import { controlSocketPath } from "../../../../infra/src/platform/control-socket";
import type { ShellPlatform } from "./ShellPlatform";

// forge.config.js packagerConfig.appBundleId — toasts are keyed by it.
const APP_USER_MODEL_ID = "com.ibrahimalbyrk.eos";

// Packaged: shipped under resources/. Dev: built into .forge-build.
function bundled(name: string): string {
  return app.isPackaged ? path.join(process.resourcesPath, name) : path.join(app.getAppPath(), ".forge-build", name);
}

const helper = (): string => bundled("EosHelper.exe");

export const win32Shell: ShellPlatform = {
  uiOS: "windows",

  // Eos Setup puts the same id on the Start menu shortcut (installer-win/src/winapi.rs).
  init() {
    app.setAppUserModelId(APP_USER_MODEL_ID);
  },

  appMenu: false,

  // No title bar and no system controls (Snap still works from the edges and
  // Win+Z): the dashboard draws its own (ui WindowControls).
  windowFrame: () => ({ titleBarStyle: "hidden" }),

  // Windows 11's acrylic; Windows 10 shows the splash card as drawn.
  splashMaterial: () => ({ backgroundMaterial: "acrylic" }),

  controlSocket: (home) => controlSocketPath(home, "pipe"),
  startDaemon: (launch, logPath) => startSupervisedDaemon({ ...launch, env: { ...launch.env, EOS_HELPER_BIN: helper() } }, logPath),
  stopDaemon: stopSupervisedDaemon,

  claudeBinary: (bundlesDir) => path.join(bundlesDir, "node_modules", "@anthropic-ai", `claude-agent-sdk-win32-${process.arch}`, "claude.exe"),

  locationHelper: (timeoutS) => ({ file: helper(), args: ["location", String(timeoutS)] }),

  clipboardFilePaths: copiedFilePaths,

  // Toasts of an app that isn't MSIX-packaged play only system sounds.
  notificationSound: undefined,

  // `eos build` is the macOS dev CLI.
  rebuild: null,

  screenSaver: null,
  applyUpdate: startWindowsUpdate,
};
