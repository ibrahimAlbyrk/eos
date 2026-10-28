import { ipcMain, shell, BrowserWindow } from "electron";
import type { WebContents } from "electron";
import { writeFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { themeBackground } from "./config";
import { persistTheme, type Theme } from "./theme";
import { shellPlatform } from "./platform";

// Run a snippet in the renderer's MAIN world (where the UI defines its __eos*
// callback globals). Errors are swallowed — a missing global just no-ops,
// matching the Swift shell's `?.()` optional calls (doc 10 §d).
function driveJs(wc: WebContents, js: string): void {
  wc.executeJavaScript(js, true).catch(() => {});
}

function sanitizeFilename(name: string): string {
  const base = path.basename(name || "download");
  return base.replace(/[/\\:]/g, "_") || "download";
}

type DirEntry = { path: string; isDir: boolean };

async function statEntries(paths: string[]): Promise<DirEntry[]> {
  const out: DirEntry[] = [];
  for (const p of paths) {
    if (!p) continue;
    try {
      out.push({ path: p, isDir: (await stat(p)).isDirectory() });
    } catch {
      out.push({ path: p, isDir: false });
    }
  }
  return out;
}

// Best-effort read of copied files' paths from the clipboard (paste of items
// copied in the file manager). The UI treats [] as "no native paths" and uploads
// the pasted bytes instead (doc 10 §f1).
async function readClipboardFilePaths(): Promise<DirEntry[]> {
  return statEntries(await shellPlatform.clipboardFilePaths());
}

// All inbound web→main handlers (the six webkit.messageHandlers, doc 10 §d 1–6)
// plus the native-DnD forwarders. `win` is the live main window.
export function registerBridge(win: BrowserWindow): void {
  const wc = win.webContents;

  // themeChanged: persist + repaint the native window background so light/dark
  // pre-paint tracks the UI (resolves the deferred §D5 light-theme repaint).
  // Never touch nativeTheme.themeSource — that would freeze prefers-color-scheme
  // in the renderer (doc 10 §d-3 note).
  ipcMain.on("eos:themeChanged", (_e, theme: unknown) => {
    const t: Theme = theme === "light" ? "light" : "dark";
    persistTheme(t);
    if (!win.isDestroyed()) win.setBackgroundColor(themeBackground(t));
  });

  // themeSnapshot: freeze the current frame → JPEG data URL → __eosThemeSnapshot,
  // driving the crossfade reveal. capturePage composites backdrop-filter into the
  // pixels, so the frozen frame is more correct than WKWebView's (doc 10 §d-4/§f6).
  // null on failure so theme.js bails to an instant apply.
  ipcMain.on("eos:themeSnapshot", async () => {
    try {
      const img = await wc.capturePage();
      const dataUrl = `data:image/jpeg;base64,${img.toJPEG(92).toString("base64")}`;
      driveJs(wc, `window.__eosThemeSnapshot && window.__eosThemeSnapshot(${JSON.stringify(dataUrl)})`);
    } catch {
      driveJs(wc, "window.__eosThemeSnapshot && window.__eosThemeSnapshot(null)");
    }
  });

  // saveFile: silent write to ~/Downloads then open — exact parity, no dialog
  // (doc 10 §d-5).
  ipcMain.on(
    "eos:saveFile",
    async (_e, payload: { filename?: string; base64?: string; mimeType?: string }) => {
      try {
        const dest = path.join(homedir(), "Downloads", sanitizeFilename(payload?.filename ?? "download"));
        await writeFile(dest, Buffer.from(payload?.base64 ?? "", "base64"));
        void shell.openPath(dest);
        console.log("[eos-electron] saveFile ->", dest);
      } catch (e) {
        console.error("[eos-electron] saveFile failed:", e instanceof Error ? e.message : String(e));
      }
    },
  );

  // pasteboardPaths: reply-style — the UI awaits handler.postMessage(null).
  ipcMain.handle("eos:pasteboardPaths", () => readClipboardFilePaths());

  // Native Finder drop, forwarded from the preload's capture-phase listener →
  // __eosNativeDrop(entries) (doc 10 §d outbound 1–4).
  ipcMain.on("eos:nativeDrop", async (_e, paths: unknown) => {
    const entries = await statEntries(Array.isArray(paths) ? paths.filter((p): p is string => typeof p === "string") : []);
    driveJs(wc, `window.__eosNativeDrop && window.__eosNativeDrop(${JSON.stringify(entries)})`);
  });
}

// Outbound: notification/menu-bar navigation → jump to a worker (App.jsx:33).
// Wired now; the firing trigger (notifications) lands in M4.
export function navigateToWorker(wc: WebContents, workerId: string): void {
  driveJs(wc, `window.__nativeNavigate && window.__nativeNavigate(${JSON.stringify(workerId)})`);
}

// Open a named view (e.g. "memory") — a notification about the user, not a worker.
export function navigateToRoute(wc: WebContents, route: string): void {
  driveJs(wc, `window.__nativeOpenRoute && window.__nativeOpenRoute(${JSON.stringify(route)})`);
}
