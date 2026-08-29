import { app, BrowserWindow, shell } from "electron";
import path from "node:path";
import { registerEosSchemePrivileges, installEosProtocol } from "./scheme";
import { resolveUiRoot, resolveDaemonUrl, themeBackground } from "./config";
import { waitForHealthy, readUiToken } from "./daemon";
import { loadPersistedTheme } from "./theme";
import { registerBridge } from "./bridge";
import { buildAppMenu } from "./menu";
import { SSEClient } from "./sse";
import { FleetFeed } from "./fleet";
import { TrayController } from "./tray";
import { makeNotifier } from "./notifications";
import { checkUpdateStatus } from "./updater";
import { initBinaryAutoUpdate } from "./updater-binary";

const DAEMON_URL = resolveDaemonUrl();
const UI_ROOT = resolveUiRoot();
const PRELOAD = path.join(__dirname, "preload.js");

// Scoped CSP on the entry document. Egress is pinned to the eos:// scheme and
// loopback (the daemon HTTP/SSE + ws + the 7401 raw origin) — the real
// defense-in-depth win. 'unsafe-inline'/'wasm-unsafe-eval' are required by the
// app's own inline theme bootstrap, emotion styles, and pdf.js wasm; tightening
// script-src to a hash/nonce is deferred. Disable with EOS_ELECTRON_DISABLE_CSP=1.
const CSP =
  process.env.EOS_ELECTRON_DISABLE_CSP === "1"
    ? null
    : [
        "default-src 'self' eos:",
        "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' eos:",
        "style-src 'self' 'unsafe-inline' eos:",
        "img-src 'self' eos: data: blob: http://127.0.0.1:*",
        "font-src 'self' eos: data:",
        "connect-src 'self' eos: http://127.0.0.1:* ws://127.0.0.1:*",
        "frame-src 'self' eos: http://127.0.0.1:7401",
        "worker-src 'self' eos: blob:",
        "media-src 'self' eos: data: blob: http://127.0.0.1:*",
        "object-src 'none'",
      ].join("; ");

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

// Must run before app.ready.
registerEosSchemePrivileges();

// Single-instance: a second launch focuses the existing window (LaunchServices
// gives the Swift app this implicitly; Electron needs it explicitly — §C6/E3).
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else app.on("second-instance", () => {
  console.log("[eos-electron] second-instance: focusing existing window");
  showMainWindow();
});

let mainWindow: BrowserWindow | null = null;
let tray: TrayController | null = null;
let quitting = false;

function showMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  }
}

// A real quit path (from the tray): bypasses the close→hide interception.
function quitApp(): void {
  quitting = true;
  app.quit();
}

function wireNavigationLockdown(win: BrowserWindow): void {
  // External links -> system browser; deny in-app window.open.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:|^mailto:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  // Block full-frame navigation away from the SPA origin.
  win.webContents.on("will-navigate", (e, url) => {
    if (url.startsWith("eos://app/")) return;
    e.preventDefault();
    if (/^https?:|^mailto:/i.test(url)) void shell.openExternal(url);
  });
  // One handler covers the main frame AND the 7401 raw subframes (replaces the
  // two Swift injected suppressor scripts, doc 10 §f9).
  win.webContents.on("context-menu", (e) => e.preventDefault());

  // Toggle the `fullscreen` class so the UI drops the traffic-light insets in the
  // fullscreen reveal state (doc 10 §b :409-419, styles.css:275-278).
  const toggleFs = (on: boolean) =>
    win.webContents
      .executeJavaScript(`document.documentElement.classList.${on ? "add" : "remove"}('fullscreen')`)
      .catch(() => {});
  win.on("enter-full-screen", () => toggleFs(true));
  win.on("leave-full-screen", () => toggleFs(false));
  // Double-click-to-zoom on -webkit-app-region:drag strips is handled natively by
  // Electron per the macOS AppleActionOnDoubleClick pref — no code needed.
}

async function createWindow(token: string): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1280,
    height: 820, // doc 10 §b default content rect
    minWidth: 800,
    minHeight: 500, // doc 10 §b minSize
    show: false, // reveal on ready-to-show — no flash (doc 10 §a)
    backgroundColor: themeBackground(loadPersistedTheme()), // opaque pre-paint tracks last theme (§D5)
    title: "Eos", // set, but hidden by hiddenInset (doc 10 §b titleVisibility hidden)
    titleBarStyle: "hiddenInset", // transparent titlebar + full-size content, native traffic lights (§D1)
    trafficLightPosition: trafficLightPos(), // tuned to the native +3pt-nudged spot (§D2)
    roundedCorners: true, // system-rounded macOS corners (§D3)
    // NB: deliberately NO `vibrancy` / `transparent` — the main window is opaque; the
    // glass is web CSS (backdrop-filter). Frosted floating overlays are handled by a
    // scoped preload CSS injection, not by making the window translucent (§D1).
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false, // live SSE dashboard must keep drawing (doc 30 Claim 3.1)
      additionalArguments: [`--eos-daemon-url=${DAEMON_URL}`, `--eos-ui-token=${token}`],
    },
  });
  mainWindow = win;
  wireNavigationLockdown(win);
  registerBridge(win); // inbound webkit.messageHandlers + native DnD (M3)
  // Background-app semantics: closing the window HIDES it (web app + scroll state
  // survive), matching isReleasedWhenClosed=false (doc 10 §b/§e). Real quit goes
  // through quitApp() (tray → quitting=true).
  win.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
  });
  win.once("ready-to-show", () => {
    win.show();
  });
  await win.loadURL("eos://app/index.html");
  return win;
}

app.whenReady().then(async () => {
  if (!gotLock) return; // a second instance already handed off to the first
  installEosProtocol(UI_ROOT, CSP);

  // Reuse the already-running daemon; this scaffold never spawns/restarts it
  // (it runs INSIDE a live Eos). If it is unreachable we surface it rather than
  // starting a second instance.
  const health = await waitForHealthy(DAEMON_URL).catch((e) => {
    console.error("[eos-electron] daemon unreachable:", e instanceof Error ? e.message : String(e));
    return null;
  });
  if (!health) {
    console.error(`[eos-electron] no healthy daemon at ${DAEMON_URL}; start Eos, then relaunch.`);
    app.exit(1);
    return;
  }
  console.log(`[eos-electron] daemon healthy (pid ${health.pid ?? "?"}) at ${DAEMON_URL}`);

  // Launch update check (parity: launchAfterHealthy). A cached GET — up-to-date ⇒
  // no splash, no delay (doc 10 §e). The destructive apply is stubbed (see
  // updater.ts).
  const upd = await checkUpdateStatus(DAEMON_URL);
  console.log("[eos-electron] update status:", JSON.stringify(upd));

  const token = await readUiToken();

  await createWindow(token);
  buildAppMenu(() => (mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null));

  // Tray + fleet feed + notifications — main-process, read-only against the
  // running daemon (§C6: after first paint so time-to-first-frame isn't blocked).
  tray = new TrayController({
    wc: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null),
    showWindow: showMainWindow,
    quit: quitApp,
  });
  await tray.init();

  const DWELL_MS = 4350;
  const fleet = new FleetFeed(DAEMON_URL, token, {
    onRunning: (r, c, conn) => void tray?.renderRunning(r, c, conn),
    onAnnounce: (c, rem) => void tray?.announce(c, rem, DWELL_MS),
    onDrained: (r, c) => tray?.drained(r, c),
  });
  const notifier = makeNotifier(() => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null), showMainWindow);
  const sse = new SSEClient(`${DAEMON_URL}/stream`, token, {
    onEvent: (reason, payload) => {
      if (reason.startsWith("worker:")) fleet.onWorkerFrame();
      else if (reason === "notification:fire") notifier(payload);
    },
    onConnectivity: (up) => fleet.setConnected(up),
  });
  fleet.start();
  sse.start();

  // Shell-binary auto-update hook (electron-updater) — inert unless packaged +
  // EOS_UPDATE_FEED set + electron-updater installed (§G layer 2 / M6).
  initBinaryAutoUpdate();

  app.on("activate", async () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
    else await createWindow(await readUiToken());
  });
}).catch((e) => {
  console.error("[eos-electron] startup failed:", e instanceof Error ? e.message : String(e));
  app.exit(1);
});

// macOS: keep the app alive when the window closes (parity, doc 10 §e).
app.on("window-all-closed", () => {
  /* no quit on macOS */
});
