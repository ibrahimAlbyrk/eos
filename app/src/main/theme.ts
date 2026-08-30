import { app } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// Persisted theme drives the opaque pre-paint background so the next launch
// paints the correct color before the bundle boots (replaces UserDefaults
// EosTheme; doc 10 §d-3 / §a initialTheme). The web keeps its own
// localStorage["cm:theme"] bootstrap — same two-store design as the Swift shell.
export type Theme = "dark" | "light";

function themeFile(): string {
  return path.join(app.getPath("userData"), "eos-theme.json");
}

export function loadPersistedTheme(): Theme {
  try {
    const raw = JSON.parse(readFileSync(themeFile(), "utf8"));
    return raw?.theme === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function persistTheme(theme: Theme): void {
  try {
    writeFileSync(themeFile(), JSON.stringify({ theme }));
  } catch {
    /* best-effort — a failed write just means the next pre-paint defaults dark */
  }
}
