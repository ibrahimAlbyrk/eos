// macOS.

import { app } from "electron";
import path from "node:path";
import { copiedFilePaths } from "./darwin/clipboard";
import { startLaunchdDaemon, stopLaunchdDaemon } from "./darwin/launch";
import { rebuildAndRelaunch } from "./darwin/rebuild";
import { installScreenSaver, lockScreen } from "./darwin/screensaver";
import { controlSocketPath } from "../../../../infra/src/platform/control-socket";
import type { ShellPlatform } from "./ShellPlatform";

// Traffic-light position. Native (main.swift TrafficLightPositioner) nudges the
// buttons +3pt up off AppKit's default; the documented target is a button
// center-y of 23pt (styles.css:1245-1247). x is AppKit-standard (Swift only
// changed y). Env-tunable for A/B measurement; defaults are the measured match.
function trafficLightPos(): { x: number; y: number } {
  return {
    x: Number(process.env.EOS_TL_X ?? "19"),
    y: Number(process.env.EOS_TL_Y ?? "16"),
  };
}

// Packaged: shipped under Contents/Resources. Dev: built into .forge-build.
function bundled(name: string): string {
  return app.isPackaged ? path.join(process.resourcesPath, name) : path.join(app.getAppPath(), ".forge-build", name);
}

// macOS shows the location prompt only for a bundle's executable.
const LOCATION_HELPER = path.join("EosLocation.app", "Contents", "MacOS", "eos-location");

export const darwinShell: ShellPlatform = {
  uiOS: "mac",

  init: () => {},

  appMenu: true,

  windowFrame: () => ({
    titleBarStyle: "hiddenInset", // transparent titlebar + full-size content, native traffic lights (§D1)
    trafficLightPosition: trafficLightPos(), // tuned to the native +3pt-nudged spot (§D2)
    roundedCorners: true, // system-rounded macOS corners (§D3)
  }),

  splashMaterial: () => ({
    vibrancy: "popover", // §D8: the pre-26 fallback material
    visualEffectState: "active", // stay lit (it shows for seconds)
  }),

  controlSocket: (home) => controlSocketPath(home, "socket"),
  startDaemon: startLaunchdDaemon,
  stopDaemon: stopLaunchdDaemon,

  // arm64-only for now (Stage 3 decision); universal later.
  claudeBinary: (bundlesDir) => path.join(bundlesDir, "node_modules", "@anthropic-ai", "claude-agent-sdk-darwin-arm64", "claude"),

  locationHelper: (timeoutS) => ({ file: bundled(LOCATION_HELPER), args: [String(timeoutS)] }),

  clipboardFilePaths: copiedFilePaths,

  // Shipped in Contents/Resources (forge.config.js extraResource). A dev run
  // (`npm start`) is the stock Electron.app, which lacks the file, so macOS
  // falls back to its default sound there.
  notificationSound: "eos-notification.aiff",

  rebuild: rebuildAndRelaunch,

  screenSaver: { lock: lockScreen, install: installScreenSaver },
};
