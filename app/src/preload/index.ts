import { contextBridge, webFrame, ipcRenderer, webUtils } from "electron";

// Config reaches the preload synchronously via webPreferences.additionalArguments
// so the globals exist at document-start, exactly like the Swift WKUserScripts
// injected them (doc 10 §a). Works under sandbox:true — process.argv carries them.
function argValue(flag: string): string {
  const prefix = `--${flag}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : "";
}

const daemonUrl = argValue("eos-daemon-url");
const rawUrl = argValue("eos-raw-url");
const uiToken = argValue("eos-ui-token");

// A view of another computer this Mac controls (main/hosts.ts): its descriptor
// arrives base64-encoded. Such a view may run that computer's own dashboard, so
// the bridges below that reach into THIS Mac (clipboard file paths, Finder drops,
// the embedded browser) are withheld from it.
function decodeHost(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
const host = decodeHost(argValue("eos-host"));
const hostView = host != null;

// The UI reads bare window.__EOS_DAEMON_URL / __EOS_UI_TOKEN (client.js) to reach
// the daemon cross-origin and to authorize privileged endpoints via x-eos-ui-token.
if (daemonUrl) contextBridge.exposeInMainWorld("__EOS_DAEMON_URL", daemonUrl);
if (rawUrl) contextBridge.exposeInMainWorld("__EOS_RAW_URL", rawUrl);
if (uiToken) contextBridge.exposeInMainWorld("__EOS_UI_TOKEN", uiToken);
if (host) contextBridge.exposeInMainWorld("__EOS_HOST", host);

// The machine switcher: every view (this Mac's and each controlled computer's)
// lists the machines and asks the shell to switch. Main owns the list.
type HostsSnapshot = { hosts: unknown[]; active: string | null; local: unknown };
contextBridge.exposeInMainWorld("eosHosts", {
  list: (): Promise<HostsSnapshot> => ipcRenderer.invoke("eosHosts:list"),
  switchTo: (id: string | null) => ipcRenderer.send("eosHosts:switch", id),
  openInWindow: (id: string) => ipcRenderer.send("eosHosts:openWindow", id),
  reconnect: (id: string) => ipcRenderer.send("eosHosts:reconnect", id),
  requestConnect: () => ipcRenderer.send("eosHosts:requestConnect"),
  onChange: (cb: (snap: HostsSnapshot) => void) => {
    const h = (_e: unknown, snap: HostsSnapshot) => cb(snap);
    ipcRenderer.on("eosHosts:changed", h);
    return () => ipcRenderer.removeListener("eosHosts:changed", h);
  },
  // Shell → UI commands (the Machines menu's "Connect a Machine…").
  onCommand: (cb: (cmd: { type: string }) => void) => {
    const h = (_e: unknown, cmd: { type: string }) => cb(cmd);
    ipcRenderer.on("eosHosts:command", h);
    return () => ipcRenderer.removeListener("eosHosts:command", h);
  },
});

// Embedded browser view — geometry/visibility channel ONLY (plan §C/§E). The
// renderer measures the browser panel's placeholder rect and reports it; the main
// process positions the native WebContentsView to track it. No webContents and no
// navigation verbs cross here — those flow renderer → daemon REST → engine.
if (!hostView) contextBridge.exposeInMainWorld("eosBrowserView", {
  setActiveView: (arg: { sessionKey: string; tabId: string }) => ipcRenderer.send("browserView:setActiveView", arg),
  setBounds: (rect: { x: number; y: number; width: number; height: number }) => ipcRenderer.send("browserView:setBounds", rect),
  setVisible: (visible: boolean) => ipcRenderer.send("browserView:setVisible", visible),
  overlayOpen: (open: boolean) => ipcRenderer.send("browserView:overlay", open),
  // A DOM layer overlaps the view: snapshot() fetches a still to stand in for it,
  // setOccluded hides/restores the live view.
  setOccluded: (occluded: boolean) => ipcRenderer.send("browserView:occluded", occluded),
  snapshot: () => ipcRenderer.invoke("browserView:snapshot"),
  // Element picker (human): drive Chromium's native inspect overlay on the live
  // view; resolves the picked element (or null if cancelled). cancelPick abandons
  // an in-flight pick when the human leaves pick mode.
  pickElement: (tabId: string) => ipcRenderer.invoke("browserView:pick", tabId),
  cancelPick: () => ipcRenderer.send("browserView:pickCancel"),
});

// Native macOS notification for the dashboard's errors/warnings (ui lib/notify.js);
// main shows it only while Eos is in the background. Withheld from a controlled
// computer's view so its page can't raise banners on this Mac.
if (!hostView) contextBridge.exposeInMainWorld("eosNotify", {
  show: (n: { title: string; body: string }) => ipcRenderer.send("eos:notify", n),
});

// Artifact link previews: the renderer asks main to render a published claude.ai
// artifact in Eos's own claude.ai session and hand back a JPEG. Withheld from a
// controlled computer's view — the login + render happen on THIS Mac.
if (!hostView) contextBridge.exposeInMainWorld("eosArtifactPreview", {
  status: (): Promise<{ signedIn: boolean }> => ipcRenderer.invoke("artifactPreview:status"),
  get: (url: string): Promise<{ state: string; dataUrl?: string }> => ipcRenderer.invoke("artifactPreview:get", url),
  connect: (): Promise<{ signedIn: boolean }> => ipcRenderer.invoke("artifactPreview:connect"),
});

// html.native gates ~30 CSS rules (titlebar/traffic-light insets, sidebar chrome).
// The DOM is shared across isolated worlds, so setting it here is visible to the
// page; guard for pre-documentElement timing (doc 20 §e-3, plan §C4 item 3).
function markNative(): void {
  if (document.documentElement) {
    document.documentElement.classList.add("native");
    return;
  }
  document.addEventListener(
    "DOMContentLoaded",
    () => document.documentElement.classList.add("native"),
    { once: true },
  );
}
markNative();

// Map the UI's `--app-region` custom property onto the real `-webkit-app-region`
// that Electron honors — without editing app/ui SOURCE. The UI sets
// `--app-region: drag` on the two titlebar strips (.side-island--chrome
// styles.css:498, .pane-head :1235) and `no-drag` on interactive controls, and
// custom properties inherit — so resolving `var(--app-region)` per element
// reproduces exactly the WKWebView JS-bridge drag map. insertCSS injects a user
// stylesheet, so it is not subject to the page CSP.
webFrame.insertCSS("html.native * { -webkit-app-region: var(--app-region, no-drag); }");

// window.webkit.messageHandlers shim — the UI's WKWebView bridge, re-provided as
// the exact same names so its capability checks light up (doc 20 §e, doc 10 §d).
// postMessage → IPC → main (bridge.ts); pasteboardPaths is reply-style so its
// postMessage returns a Promise the UI awaits. titlebarDrag/DblClick are no-ops —
// window drag is real -webkit-app-region CSS in Electron (§D4), the shim shape is
// kept only so the injected-script contract survives.
contextBridge.exposeInMainWorld("webkit", {
  messageHandlers: {
    themeChanged: { postMessage: (t: unknown) => ipcRenderer.send("eos:themeChanged", t) },
    themeSnapshot: { postMessage: () => ipcRenderer.send("eos:themeSnapshot") },
    saveFile: { postMessage: (p: unknown) => ipcRenderer.send("eos:saveFile", p) },
    ...(hostView ? {} : { pasteboardPaths: { postMessage: () => ipcRenderer.invoke("eos:pasteboardPaths") } }),
    titlebarDrag: { postMessage: () => {} },
    titlebarDblClick: { postMessage: () => {} },
  },
});

// Finder drag/drop interception: the Swift EosWebView swallowed file drags before
// the DOM and delivered real paths via __eosNativeDrop/__eosDragState (doc 10 §d
// outbound 1–4). Capture-phase listeners reproduce that — preventDefault so the
// UI's own DnD doesn't double-handle, resolve real paths via webUtils
// (File.path is gone in modern Electron), and let main stat isDir + drive the globals.
function hasFiles(e: DragEvent): boolean {
  // A controlled computer's view gets no local paths — they mean nothing there.
  return !hostView && !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
}
document.addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  ipcRenderer.send("eos:dragState", true);
}, true);
document.addEventListener("dragover", (e) => {
  if (hasFiles(e)) e.preventDefault();
}, true);
document.addEventListener("dragleave", (e) => {
  // Only the window-level leave (relatedTarget null) toggles off, to avoid
  // flicker when the cursor crosses child element boundaries.
  if (!hasFiles(e) || (e as DragEvent).relatedTarget) return;
  ipcRenderer.send("eos:dragState", false);
}, true);
document.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  const paths: string[] = [];
  for (const f of Array.from(e.dataTransfer?.files ?? [])) {
    try {
      const p = webUtils.getPathForFile(f);
      if (p) paths.push(p);
    } catch {
      /* not a real file */
    }
  }
  ipcRenderer.send("eos:dragState", false);
  ipcRenderer.send("eos:nativeDrop", paths);
}, true);
