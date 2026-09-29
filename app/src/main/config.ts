import { app } from "electron";
import path from "node:path";

export const DEFAULT_DAEMON_URL = "http://127.0.0.1:7400";

// Opaque theme-matched backgrounds painted before first paint (doc 10 §a
// themeBackground): no white flash while the bundle boots.
export const DARK_BG = "#1a1a1a";
export const LIGHT_BG = "#f6f1e6";

// The built web bundle (Vite base:"./" — scheme-agnostic). Packaged: bundled into
// Contents/Resources/dist via Forge extraResource. Dev: the nested UI package at
// app/ui/dist, where app.getAppPath() is the package dir (this file's app/).
// EOS_UI_DIST overrides either.
export function resolveUiRoot(): string {
  const override = process.env.EOS_UI_DIST?.trim();
  if (override) return override;
  if (app.isPackaged) return path.join(process.resourcesPath, "dist");
  return path.join(app.getAppPath(), "ui", "dist");
}

export function resolveDaemonUrl(): string {
  return process.env.EOS_DAEMON_URL?.trim() || DEFAULT_DAEMON_URL;
}

// The daemon's raw-content origin (fs/raw, pdf.js) — a separate origin by design.
// EOS_RAW_URL overrides; otherwise the daemon's host on its default raw port.
export function resolveRawUrl(daemonUrl: string): string {
  const override = process.env.EOS_RAW_URL?.trim();
  if (override) return override;
  const u = new URL(daemonUrl);
  u.port = "7401";
  return u.origin;
}

export function themeBackground(theme: "dark" | "light"): string {
  return theme === "light" ? LIGHT_BG : DARK_BG;
}
