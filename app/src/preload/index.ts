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
const uiToken = argValue("eos-ui-token");

// The UI reads bare window.__EOS_DAEMON_URL / __EOS_UI_TOKEN (client.js) to reach
// the daemon cross-origin and to authorize privileged endpoints via x-eos-ui-token.
if (daemonUrl) contextBridge.exposeInMainWorld("__EOS_DAEMON_URL", daemonUrl);
if (uiToken) contextBridge.exposeInMainWorld("__EOS_UI_TOKEN", uiToken);

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
    pasteboardPaths: { postMessage: () => ipcRenderer.invoke("eos:pasteboardPaths") },
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
  return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
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
