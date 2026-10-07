import { app, BrowserWindow, shell, dialog, ipcMain } from "electron";
import path from "node:path";
import { registerEosSchemePrivileges, installEosProtocol } from "./scheme";
import { resolveUiRoot, resolveDaemonUrl, resolveRawUrl, themeBackground } from "./config";
import {
  readUiToken,
  probeDaemon,
  waitHealthy,
  startDaemon,
  stopDaemon,
  resolveRepoRoot,
  daemonSocketPath,
  daemonLogPath,
  unreachableHint,
} from "./daemon";
import { createSplash, dismissSplash } from "./splash";
import { loadPersistedTheme } from "./theme";
import { registerBridge } from "./bridge";
import { buildAppMenu } from "./menu";
import { SSEClient } from "./sse";
import { FleetFeed } from "./fleet";
import { TrayController } from "./tray";
import { makeNotifier } from "./notifications";
import { checkUpdateStatus } from "./updater";
import { initBinaryAutoUpdate } from "./updater-binary";
import { initBrowserHost } from "./browser";
import { initArtifactPreview } from "./artifactPreview";
import { HostViews } from "./hosts";
import { TransferBridge } from "./transfers";
import { rebuildAndRelaunch } from "./rebuild";
import type { MenuItemConstructorOptions } from "electron";

const DAEMON_URL = resolveDaemonUrl();
const RAW_URL = resolveRawUrl(DAEMON_URL);
const UI_ROOT = resolveUiRoot();
const PRELOAD = path.join(__dirname, "preload.js");

// Scoped CSP on the entry document. Egress is pinned to the eos:// scheme and
// loopback (the daemon HTTP/SSE + ws + the 7401 raw origin) — the real
// defense-in-depth win. 'unsafe-inline'/'wasm-unsafe-eval' are required by the
// app's own inline theme bootstrap, emotion styles, and pdf.js wasm; tightening
// script-src to a hash/nonce is deferred. Disable with EOS_ELECTRON_DISABLE_CSP=1.
function buildCsp(egress: { api: string; raw: string; ws: string }): string | null {
  if (process.env.EOS_ELECTRON_DISABLE_CSP === "1") return null;
  return [
    "default-src 'self' eos:",
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' eos:",
    "style-src 'self' 'unsafe-inline' eos:",
    `img-src 'self' eos: data: blob: ${egress.api} ${egress.raw}`,
    "font-src 'self' eos: data:",
    `connect-src 'self' eos: ${egress.api} ${egress.ws}`.trim(),
    `frame-src 'self' eos: ${egress.raw}`,
    "worker-src 'self' eos: blob:",
    `media-src 'self' eos: data: blob: ${egress.api} ${egress.raw}`,
    "object-src 'none'",
  ].join("; ");
}

const CSP = buildCsp({ api: "http://127.0.0.1:*", raw: "http://127.0.0.1:*", ws: "ws://127.0.0.1:*" });

// A controlled computer's view may run that computer's own dashboard code, so
// its egress is pinned to its host's facade prefixes — never the rest of this
// Mac's daemon. (A CSP source ending in "/" matches that path and below.)
const hostCsp = (apiBase: string, rawBase: string): string | null =>
  buildCsp({ api: `${apiBase}/`, raw: `${rawBase}/`, ws: "" });

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

// A dev build next to the installed app: its own profile, so it neither shares
// state with nor hands off (single-instance) to the installed Eos.
if (process.env.EOS_ELECTRON_USER_DATA?.trim()) app.setPath("userData", process.env.EOS_ELECTRON_USER_DATA.trim());

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
let hostViews: HostViews | null = null;
let transferBridge: TransferBridge | null = null;
let tray: TrayController | null = null;
let quitting = false;
// True when THIS app started the daemon (false when we adopted an already-running
// one). Only a daemon we started is ever stopped on quit.
let ownsDaemon = false;
let splashWin: BrowserWindow | null = null;
// Agents working right now (fleet feed) — a rebuild asks first when any are.
let busyAgents = 0;
const rebuild = (): void => void rebuildAndRelaunch(busyAgents);
// Resolves once a healthy daemon is confirmed. The main window may load before
// that (in parallel with the daemon boot) but stays hidden until then.
let markDaemonReady!: () => void;
const daemonReady = new Promise<void>((resolve) => { markDaemonReady = resolve; });

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

// A dead renderer (e.g. a V8 crash after hours in the background) leaves the
// window blank until a manual ⌘R — reload it ourselves. A second death within
// RELOAD_GUARD_MS of our reload is left alone so a crash-on-boot can't spin.
const RELOAD_GUARD_MS = 10_000;
function wireRendererRecovery(win: BrowserWindow): void {
  let lastReload = 0;
  win.webContents.on("render-process-gone", (_e, { reason, exitCode }) => {
    console.error(`[eos-electron] renderer gone: ${reason} (exit ${exitCode})`);
    if (quitting || win.isDestroyed() || reason === "clean-exit") return;
    if (Date.now() - lastReload < RELOAD_GUARD_MS) return;
    lastReload = Date.now();
    win.webContents.reload();
  });
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
      additionalArguments: [`--eos-daemon-url=${DAEMON_URL}`, `--eos-raw-url=${RAW_URL}`, `--eos-ui-token=${token}`],
    },
  });
  mainWindow = win;
  wireNavigationLockdown(win);
  wireRendererRecovery(win);
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
    void daemonReady.then(() => {
      if (win.isDestroyed()) return;
      win.show();
      // The boot splash (only created when we had to spawn the daemon) hands off to
      // the real window here.
      if (splashWin) {
        dismissSplash(splashWin);
        splashWin = null;
      }
    });
  });
  await win.loadURL("eos://app/index.html");
  return win;
}

// Own the daemon lifecycle. Probe socket-first, then TCP:
//   UP          → adopt it (ownsDaemon stays false → we never stop it).
//   DOWN        → spawn OUR daemon, show the boot splash, wait until healthy.
//   UNREACHABLE → never spawn (a healthy daemon may just be unprobeable — a 2nd
//                 daemon shares ~/.eos and corrupts state); surface + offer retry.
// Resolves true when a daemon is healthy; false if the user chose to quit.
async function ensureDaemon(): Promise<boolean> {
  const socket = daemonSocketPath();
  for (;;) {
    let health = await probeDaemon(DAEMON_URL, socket);

    if (health.state === "up") {
      console.log("[eos-electron] daemon already up — adopting (not ours, won't stop on quit)");
      return true;
    }

    if (health.state === "unreachable") {
      const { response } = await dialog.showMessageBox({
        type: "error",
        title: "Eos",
        message: "Can’t reach the Eos daemon",
        detail: `${unreachableHint(health.code)}\n\nNot starting a second daemon — it could collide with one already running.`,
        buttons: ["Retry", "Quit"],
        defaultId: 0,
        cancelId: 1,
      });
      if (response === 1) return false;
      continue;
    }

    // DOWN → boot our own. The splash appears ONLY here (a real wait); the adopt
    // path above never flashes it.
    if (!splashWin) splashWin = createSplash();
    console.log("[eos-electron] daemon down — starting ours");
    try {
      await startDaemon(resolveRepoRoot(), daemonLogPath());
      ownsDaemon = true;
      health = await waitHealthy(DAEMON_URL, 40_000, socket);
    } catch (e) {
      console.error("[eos-electron] daemon start failed:", e instanceof Error ? e.message : String(e));
      health = { state: "down" };
    }
    if (health.state === "up") {
      console.log("[eos-electron] started daemon healthy");
      return true;
    }

    // Boot failed — tear down ONLY our daemon, then surface + offer retry.
    stopOwnedDaemon();
    const detail =
      health.state === "unreachable"
        ? unreachableHint(health.code)
        : "The daemon did not become healthy in time. See ~/.eos/logs/daemon.log.";
    const { response } = await dialog.showMessageBox({
      type: "error",
      title: "Eos",
      message: "Eos daemon failed to start",
      detail,
      buttons: ["Retry", "Quit"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 1) return false;
  }
}

// Stop ONLY a daemon this app started. launchd sends SIGTERM, which runs the
// daemon's own graceful shutdown (suspend workers, unlink pid + socket), then
// reaps its process group. No-op when we adopted (ownsDaemon is false).
function stopOwnedDaemon(): void {
  if (!ownsDaemon) return;
  ownsDaemon = false;
  stopDaemon();
  console.log("[eos-electron] stopped our daemon");
}

function focusedContents() {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  return hostViews ? hostViews.focusedContents() : mainWindow.webContents;
}

// ⌃1 is always this Mac; the controlled computers follow in the Machines menu's order.
function machinesMenu(): MenuItemConstructorOptions | undefined {
  if (!hostViews) return undefined;
  const active = hostViews.current();
  const items: MenuItemConstructorOptions[] = [
    { label: "This Mac", type: "radio", checked: active == null, accelerator: "Ctrl+1", click: () => void hostViews?.switchTo(null) },
    ...hostViews.list().slice(0, 8).map((h, i): MenuItemConstructorOptions => ({
      label: h.alias ?? h.name,
      type: "radio",
      checked: active === h.id,
      accelerator: `Ctrl+${i + 2}`,
      click: () => void hostViews?.switchTo(h.id),
    })),
    { type: "separator" },
    {
      label: "Connect a Machine…",
      click: () => {
        void hostViews?.switchTo(null);
        mainWindow?.webContents.send("eosHosts:command", { type: "connect" });
      },
    },
  ];
  return { label: "Machines", submenu: items };
}

// Link-state ticks (latency) fire often; the menu only changes with the list.
let menuKey = "";
function rebuildMenu(): void {
  const key = hostViews ? `${hostViews.current()}|${hostViews.list().map((h) => `${h.id}:${h.alias ?? h.name}`).join(",")}` : "";
  if (key === menuKey && key !== "") return;
  menuKey = key;
  buildAppMenu(focusedContents, rebuild, machinesMenu());
}

// Non-critical, main-process, read-only wiring — deferred past first paint so the
// window is interactive immediately (§C6), especially on the fast adopt path.
async function startBackgroundServices(token: string): Promise<void> {
  try {
    const upd = await checkUpdateStatus(DAEMON_URL);
    console.log("[eos-electron] update status:", JSON.stringify(upd));
  } catch (e) {
    console.error("[eos-electron] update check failed:", e instanceof Error ? e.message : String(e));
  }

  tray = new TrayController({
    wc: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null),
    showWindow: showMainWindow,
    rebuild,
    quit: quitApp,
  });
  await tray.init();

  const DWELL_MS = 4350;
  const fleet = new FleetFeed(DAEMON_URL, token, {
    onRunning: (r, c, conn) => {
      busyAgents = c;
      void tray?.renderRunning(r, c, conn);
    },
    onAnnounce: (c, rem) => void tray?.announce(c, rem, DWELL_MS),
    onDrained: (r, c) => tray?.drained(r, c),
  });
  const notifier = makeNotifier(
    () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null),
    showMainWindow,
    async (hostId) => {
      await hostViews?.switchTo(hostId);
      const wc = hostViews?.focusedContents() ?? null;
      // A freshly built view is still loading its dashboard.
      if (wc?.isLoading()) await new Promise<void>((resolve) => wc.once("did-finish-load", () => setTimeout(resolve, 600)));
      return wc;
    },
  );
  // The dashboard's own errors/warnings (ui lib/notify.js) take the same native path.
  ipcMain.on("eos:notify", (_e, payload: unknown) => void notifier(payload));
  let hostsRefresh: ReturnType<typeof setTimeout> | null = null;
  const sse = new SSEClient(`${DAEMON_URL}/stream`, token, {
    onEvent: (reason, payload) => {
      if (reason.startsWith("worker:")) fleet.onWorkerFrame();
      else if (reason === "notification:fire") notifier(payload);
      else if (reason === "transfer:change") transferBridge?.forward(payload);
      else if (reason === "hosts:change" && !hostsRefresh) {
        // Link state ticks (latency) arrive in bursts — coalesce the refetch.
        hostsRefresh = setTimeout(() => { hostsRefresh = null; void hostViews?.refresh(); }, 150);
      }
    },
    onConnectivity: (up) => fleet.setConnected(up),
  });
  fleet.start();
  sse.start();

  // Shell-binary auto-update hook (electron-updater) — inert unless packaged +
  // EOS_UPDATE_FEED set + electron-updater installed (§G layer 2 / M6).
  initBinaryAutoUpdate();
}

app.whenReady().then(async () => {
  if (!gotLock) return; // a second instance already handed off to the first
  installEosProtocol(UI_ROOT, CSP);

  // The UI mounts only once /health answers (app/ui/src/main.jsx), so with the
  // token already on disk the window loads WHILE the daemon boots instead of
  // after it. First run has no token yet (the daemon writes it) → load after.
  const earlyToken = await readUiToken().catch(() => null);
  const earlyWin = earlyToken ? createWindow(earlyToken) : null;
  earlyWin?.catch(() => {}); // awaited below only when the daemon comes up

  const ready = await ensureDaemon();
  if (!ready) {
    quitApp();
    return;
  }
  markDaemonReady();

  const token = await readUiToken();
  let win: BrowserWindow; // shows on ready-to-show + dismisses the splash
  if (earlyWin && token === earlyToken) {
    win = await earlyWin;
  } else {
    // The daemon minted a new token while booting — the early window holds a stale one.
    if (earlyWin) (await earlyWin).destroy();
    win = await createWindow(token);
  }
  // Other computers this Mac controls live in isolated views inside this window;
  // the menu's edit commands act on whichever view is showing.
  hostViews = new HostViews({
    win, daemonUrl: DAEMON_URL, rawUrl: RAW_URL, uiToken: token, uiRoot: UI_ROOT, preload: PRELOAD,
    csp: hostCsp, onChange: rebuildMenu,
  });
  rebuildMenu();
  void hostViews.refresh();
  // The Transfer tab inside a view of another computer reaches this Mac's engine here.
  const views = hostViews;
  transferBridge = new TransferBridge({
    daemonUrl: DAEMON_URL, uiToken: token,
    hostFor: (wc) => views.hostFor(wc),
    contentsFor: (id) => views.contentsFor(id),
    hostContents: () => views.hostContents(),
    fallbackWindow: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null),
  });

  // Embedded-browser lane: register this app as the daemon's browser host and own
  // the native WebContentsView views (M1/M2). The renderer positions them via the
  // eosBrowserView preload bridge; the daemon drives them over /browser/host.
  initBrowserHost({ win, daemonUrl: DAEMON_URL, uiToken: token });

  // Artifact link previews render in Eos's own claude.ai session (artifactPreview.ts).
  initArtifactPreview(() => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null));

  // Defer the rest so it can't block time-to-first-frame.
  setImmediate(() => void startBackgroundServices(token));

  app.on("activate", async () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
    else await createWindow(await readUiToken());
  });
}).catch((e) => {
  console.error("[eos-electron] startup failed:", e instanceof Error ? e.message : String(e));
  stopOwnedDaemon(); // never orphan a daemon we started
  app.exit(1);
});

// Clean shutdown: on real quit, stop ONLY the daemon we started. An adopted
// daemon (ownsDaemon === false) is deliberately left running.
//
// before-quit fires for every genuine app quit (Cmd+Q, Dock → Quit, the
// `tell application "Eos" to quit` AppleEvent the installer sends, macOS logout)
// but NOT for a plain window close. Set `quitting` here so the window's
// close→hide interception (below) falls through to a real close: without this the
// interception swallows Cmd+Q/Dock-Quit and the app can only be quit from the
// tray or Activity Monitor — which is also why `eos build --app`'s graceful quit
// never terminated the old instance.
app.on("before-quit", () => {
  quitting = true;
  stopOwnedDaemon();
});

// macOS: keep the app alive when the window closes (parity, doc 10 §e).
app.on("window-all-closed", () => {
  /* no quit on macOS */
});
