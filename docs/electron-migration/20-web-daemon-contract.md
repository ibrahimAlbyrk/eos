# Web ⇄ Native-shell / daemon contract (for the Electron port)

Read-only audit of `app/ui`, `contracts/`, and daemon-discovery code. Goal: enumerate
**everything the React web UI assumes the native shell provides, and everything it
assumes about the daemon**, so an Electron main+preload can re-provide the same surface and
run the existing UI with zero (or near-zero) UI code changes.

Key architectural fact that shapes all of this: the UI is **not** served from the daemon.
The macOS shell serves the built `dist/` from a custom `eos://app/` scheme and the UI reaches
the daemon **cross-origin** over loopback HTTP/SSE. So the UI cannot derive the daemon URL
from `location.origin` — the shell injects it. Every coupling below flows from that.

Detection is **capability-based, never userAgent-based** — there is no UA / platform sniffing
anywhere in `app/ui/src` (grep for `userAgent|isElectron|isWKWebView|navigator.platform` is
empty). The UI branches on the *presence* of `window.webkit.messageHandlers.*` and injected
`window.__EOS_*` globals, and styles branch on the injected `html.native` class. This is good
for Electron: expose the same globals/handlers and the same code paths light up.

---

## (a) Native-shell coupling in the web code

Every place the web code reaches for the shell. Grouped by mechanism.

### Injected `window.__EOS_*` globals (shell → web, read by UI)

| Global | Read at | What the UI expects |
|---|---|---|
| `window.__EOS_DAEMON_URL` | `app/ui/src/api/client.js:12-13` | Daemon base origin for all HTTP + SSE. Falls back to `http://127.0.0.1:7400` if absent. |
| `window.__EOS_UI_TOKEN` | `app/ui/src/api/client.js:80-87`; `app/ui/src/state/browserPanelStore.js:88` | Per-boot secret sent as `x-eos-ui-token` header (and `?uiToken=` on the browser WS) on every mutating/privileged endpoint. |

Injected by the shell as `WKUserScript`s at document-start: `app/main.swift:280-283` (daemon URL)
and `app/main.swift:490-502` (UI token, read from `~/.eos/ui-token` after the daemon is healthy).

### `window.webkit.messageHandlers.*` (web → shell, request/command)

| Handler | Call site | Purpose |
|---|---|---|
| `saveFile` | `app/ui/src/api/client.js:815-817` | `<a download>` doesn't work under `eos://`; posts `{filename, base64, mimeType}`; shell writes to `~/Downloads` and opens it (`app/main.swift:1056-1072`). |
| `themeChanged` | `app/ui/src/settings/theme.js:20` | Notifies shell of resolved theme so the window/webview background matches (`app/main.swift:1093-1100`). |
| `themeSnapshot` | `app/ui/src/settings/theme.js:35,103` | Requests a frozen frame for the theme-crossfade; shell replies by calling `window.__eosThemeSnapshot(dataURL)` (`app/main.swift:1074-1091`). |
| `pasteboardPaths` | `app/ui/src/lib/nativeBridge.js:8-22` | Reply-style handler (`postMessage(null)` awaits a value) returning `[{path,isDir}]` from `NSPasteboard` — WKWebView never gives JS absolute file paths (`app/main.swift:335,1050-1054`). |
| `titlebarDrag` / `titlebarDblClick` | injected titlebar script `app/main.swift:312-328` | Window drag/zoom (see `--app-region` below). These are injected by the shell, not authored in `app/ui`, but the UI's `--app-region` CSS is what drives them. |

Detection helpers gate on handler presence: `hasPasteboardBridge()` = `!!window.webkit?.messageHandlers?.pasteboardPaths` (`app/ui/src/lib/nativeBridge.js:8-10`); theme.js checks `window.webkit?.messageHandlers?.themeSnapshot` before the native crossfade path.

### `window.__eos*` callback globals (shell → web, pushed events)

| Global | Defined at | Shell calls it from |
|---|---|---|
| `window.__eosNativeDrop(entries)` | `app/ui/src/lib/nativeBridge.js:27-29` | `app/main.swift:139` on Finder drop over the webview. |
| `window.__eosDragState(active)` | `app/ui/src/lib/nativeBridge.js:30-32` | `app/main.swift:113,124,134` on drag enter/exit. |
| `window.__eosThemeSnapshot(dataUrl)` | `app/ui/src/settings/theme.js:55-57` | `app/main.swift:1084,1088` — reply to `themeSnapshot`. |
| `window.__nativeNavigate(id)` | `app/ui/src/App.jsx:33-34` | `app/main.swift:809` (notification tap) and `app/StatusBar/AgentNavigator.swift:36` (menu-bar navigator) → select worker + Code view. |
| `window.__eosTerm` (`{isFocused, getSelectionIfFocused, selectAll, pasteBase64}`) | `app/ui/src/components/terminal/terminalBridge.js:38-58` | Native Edit-menu ⌘C/⌘X/⌘V/⌘A drive xterm clipboard here because AppKit eats those keys before the webview. |
| `window.__eosUndo` / `window.__eosRedo` | `app/ui/src/hooks/useContentEditableEditor.js:285-286` | Native Edit-menu Undo/Redo for the composer contentEditable. |

### `html.native` class + `--app-region` (shell-injected, CSS-driven)

- Shell adds `document.documentElement.classList.add('native')` at document-start (`app/main.swift:287`) and `.fullscreen` on fullscreen (`app/main.swift:412`). ~30 style rules key on `html.native` / `html.native.fullscreen` for the custom titlebar, traffic-light insets, and sidebar chrome (`app/ui/src/styles.css:217-278`, and `html.native .agents-section` text-select at `:259`).
- `--app-region: drag | no-drag` custom property (`app/ui/src/styles.css:498,518,233,243,251,257,1235,1239,1421`) is **not real CSS** — WKWebView ignores `-webkit-app-region`. The injected titlebar script reads `getComputedStyle(el).getPropertyValue('--app-region')` on mousedown and calls `performWindowDrag` (`app/main.swift:307-328,1102+`). Electron **does** honor `-webkit-app-region: drag`, but only on the literal property name, so either add a CSS shim mapping `--app-region`→`-webkit-app-region` or re-provide the same mousedown→drag bridge.

### `eos://app/` origin assumptions

- `app/ui/src/api/client.js:9-11` — comment + logic: daemon URL can't come from `location.origin` because origin is `eos://app/`.
- `app/ui/src/lib/mdLinkResolve.js:3` and `app/ui/src/hooks/useMarkdownLinks.js:45` — authored markdown hrefs get mis-resolved against `eos://app/`; the UI re-resolves the RAW href. If the Electron origin is `http(s)://` or `file://`, relative-link resolution changes and these workarounds must be re-checked.

---

## (b) Daemon connectivity

### Base URL / port / socket discovery
- **Daemon HTTP origin**: `window.__EOS_DAEMON_URL` else `http://127.0.0.1:7400` (`app/ui/src/api/client.js:12-13`). The UI has **no** unix-socket path — the socket (`~/.eos/daemon.sock`) is used by CLI/hook/workers, never the browser (browsers can't dial a UDS). Electron just needs to inject the right `http://127.0.0.1:<port>`.
- **Raw-content origin**: `RAW_ORIGIN` = same host with port forced to `7401` (`app/ui/src/api/client.js:14-25`). Separate origin by design (sandboxed runnable HTML / pdf.js); used by `rawUrl()`, `pdfViewerUrl()` (`client.js:317-321`). If the daemon port is ever non-default, note the UI **hardcodes the +1 → 7401 mapping**, matching the app-shell's hardcoded 7400 assumption.
- **Per-tab client id**: `CLIENT_ID = crypto.randomUUID()` (`app/ui/src/api/client.js:31-33`), sent on `/stream?clientId=` and `/fs/watch` so the daemon ties directory watches to the SSE connection and releases them when the tab drops.

### SSE stream(s)
- Main event stream: `new EventSource(`${DAEMON}${ROUTES.stream}?clientId=…`)` where `ROUTES.stream = "/stream"` (`app/ui/src/api/client.js:832-834`, `app/ui/src/api/routes.js:12`). Carries all live state: worker/orchestrator updates (`change` events), `pty:data`, `terminal:chunk`, fs-change, etc.
- Reconnection: `app/ui/src/api/sse.js` wraps `EventSource` with exponential backoff (1s→60s), max 50 attempts, and an explicit re-create on `onerror` because the native retry sometimes doesn't fire after a hard daemon restart.
- **Second, independent SSE consumer = the shell itself**: `app/main.swift:833-867` opens its OWN `URLSession` stream to `${DAEMON}/stream` and posts native notifications on attention lines (`showNotification`, `:820-828`). This is NOT the web EventSource — Electron's main process must replicate it (see (e)).

### Browser-panel WebSocket
- `browserStreamUrl()` = `api.daemon.replace(/^http/,"ws") + "/browser/stream?uiToken=" + TOKEN` (`app/ui/src/state/browserPanelStore.js:104-107`), consumed by `new WebSocket(browserStreamUrl())` in `app/ui/src/views/browser/BrowserPanel.jsx:103`. Streams remote-browser frames. Auth is via the `?uiToken=` **query param** (WebSocket can't set custom headers).

### Auth / token / header scheme
- Single scheme: per-boot UI token in the `x-eos-ui-token` header, added by `uiTokenHeader()` (`app/ui/src/api/client.js:80-87`) to every checkout-mutating / privileged endpoint (git ops, fs writes, pty, terminal, memory, remote, anthropic config, update-apply, etc. — see the `uiTokenHeader()` call sites throughout `client.js`). Open reads (health, workers list, events) send no token. No cookies, no bearer/OAuth, no CSRF token — loopback + this shared secret is the whole model. `browserFetch` re-implements the same header for the `/browser/*` routes (`browserPanelStore.js:90-102`).
- Route source of truth: `contracts/src/http.ts` `ROUTES` (mirrored/consumed via `app/ui/src/api/routes.js`). These are **paths only** — no origin is baked into contracts, so pointing the UI at a different origin is purely the injected `__EOS_DAEMON_URL`.

---

## (c) Web-platform features WKWebView limits (and how they change in Electron)

Electron (Chromium) is *more* permissive than WKWebView on most of these, so several native
shims exist purely to work around WKWebView and can be **simplified or dropped** in Electron —
but the UI still *calls* them by capability check, so the globals must at minimum exist or the
feature silently no-ops.

| Feature | WKWebView behavior today | Where | Electron |
|---|---|---|---|
| Clipboard **read** | `navigator.clipboard.readText` is permission-gated / blocked; terminal paste routed through native `__eosTerm.pasteBase64` | `app/ui/src/components/terminal/terminalBridge.js:49-56`; `TerminalView.jsx:76` | Chromium allows clipboard read in a focused window; the native bridge becomes optional but is still invoked for ⌘V routed by the OS menu. |
| Clipboard **write** | Works (`navigator.clipboard.writeText`) — used widely | `ToolDetail.jsx`, `MessageRow.jsx`, `FileViewer.jsx`, `GitDiffFileMenu.jsx`, `BranchManager.jsx`, `FilesContextMenu.jsx`, `MessageAssistant.jsx:16-17`, … | Works. No shim. |
| Paste of an **image/file** from clipboard | Clipboard-backed `File` goes empty once the clipboard changes, so bytes are read synchronously in the paste event | `app/ui/src/api/client.js:322-327`; `app/ui/src/hooks/useAttachmentIntake.js:104-121` | Chromium keeps the File readable; sync read still safe. |
| **Drag-and-drop of real files** | `dataTransfer` carries only blob copies; a dragged Finder folder is a typeless empty File; absolute paths unavailable → native `pasteboardPaths` + `__eosNativeDrop` bridge | `app/ui/src/lib/nativeBridge.js:1-42`; drop wiring `useContentEditableEditor.js:399` | Electron exposes `File.path` for dropped files natively — the whole pasteboard bridge can be replaced by reading `e.dataTransfer.files[i].path` in preload, but the UI expects the `[{path,isDir}]` shape from the globals. |
| File **open** dialog | `api.pickDirectory()` / `api.pickFiles()` hit **daemon** routes backed by `osascript` (`choose folder`/`choose file`) — runs in the daemon process, panel is app-detached | `app/ui/src/api/client.js:306-315`; `manager/routes/fs-picker.ts:28,38`; `infra/src/filesystem/DarwinFsHelpers.ts:70-95` | Still works via daemon, but the panel won't be parented to the Electron window. Consider routing to Electron `dialog.showOpenDialog` for a modal-to-window experience (optional). |
| File **save** / download | `<a download>` unsupported under `eos://` → `saveFile` messageHandler → `~/Downloads` | `app/ui/src/api/client.js:798-828`; `app/main.swift:1056-1072` | Chromium supports `<a download>`; but the code prefers `window.webkit.messageHandlers.saveFile` when present, else falls back to the `<a download>` path (`client.js:815-824`). In Electron either leave the anchor fallback (works) or expose an equivalent save shim. |
| Desktop **notifications** | The web layer uses **no** `Notification` API (grep empty). Native shell posts `UNUserNotification` from its own SSE consumer; tap → `__nativeNavigate` | `app/main.swift:791-828,833-867`; tap handler `app/main.swift:803-812` | Must be re-provided by Electron main: subscribe to `/stream`, post `Notification`, on click focus window + `webContents.executeJavaScript("window.__nativeNavigate('…')")`. |
| **External links** | `decidePolicyFor` opens `http/https/mailto` in the OS browser, cancels in-frame nav of `linkActivated`; own `eos://` links cancelled | `app/main.swift:873-889` | No `window.open`/`target=_blank` in the UI (grep empty), so this is entirely shell-side. Electron: `webContents.setWindowOpenHandler` + `will-navigate` → `shell.openExternal`. |
| **Context menu** | Native suppressed (`preventDefault` injected) on both main frame and 7401 subframe | `app/main.swift:288-305` | Re-provide, or the UI's own context menus compete with Chromium's default. |
| **Window management / titlebar** | Custom traffic-light insets, `--app-region` drag, fullscreen class toggling | `app/main.swift:307-328,412`; `app/ui/src/styles.css:217-278` | Frameless BrowserWindow + `-webkit-app-region` (see (a)); add fullscreen `enter/leave-full-screen` → toggle `.fullscreen` class. |
| **Media / getUserMedia / permissions** | Not used anywhere in the UI (grep empty) | — | Nothing to provide. |
| `localStorage` | Used for **ephemeral UI state** — theme bootstrap (`index.html:16-24`), active view/scroll (`navigation.jsx`, `homeStore.js`, `explorerStore.js`, `customGroupsStore.js`, `sidebarPrefsStore.js`, `browserSessionState.js`). **Durable** settings deliberately live daemon-side via `/settings` (`client.js:594-603`) because the origin's localStorage isn't treated as reliable across launches | — | Works in Electron, **but** the origin changes from `eos://app/` to the Electron origin → existing localStorage is not visible under the new origin (one-time reset of ephemeral prefs; durable settings unaffected since they're daemon-side). |

---

## (d) Build / serve assumptions

- **Vite `base: "./"`** (`app/ui/vite.config.js:6`) → all asset URLs are **relative** so they resolve against `index.html` regardless of the scheme host. Output: `dist/`, `target: es2022`, `sourcemap: true`, manual code-split chunks (`vite.config.js:8-27`). This relative-base build is directly Electron-friendly (load via `file://…/dist/index.html` or a custom scheme).
- **Load path**: shell serves `dist/` via a custom `eos://` scheme handler (`BundledUISchemeHandler`, `app/main.swift:273-274`) and loads `eos://app/index.html` (`app/main.swift:509`). Nothing in the built output assumes port/host — only the injected `__EOS_DAEMON_URL` points at the daemon.
- **Entry HTML** (`app/ui/index.html`): inline theme bootstrap reads `localStorage["cm:theme"]` before the bundle to avoid FOUC (`:13-25`); module entry `/src/main.jsx` (`:29`) → hashed `dist/assets/*` in prod. `<link rel=icon href="./logo.png">` is relative.
- **Runtime origin the app assumes**: `eos://app/` — explicitly *not* `location.origin` for daemon calls (`client.js:9-11`). Raw sandbox content is on a **separate** origin `http://127.0.0.1:7401` by design (`client.js:14-16`). Electron should either (i) keep a custom scheme `app://` to preserve a stable non-`file` origin, or (ii) use `file://` and accept the origin change — but must keep the daemon on a distinct http origin so the token/CORS model is unchanged.
- **CORS**: because UI origin ≠ daemon origin, the daemon already serves cross-origin to a non-http origin today; keeping the daemon at `http://127.0.0.1:7400` and the UI at any Electron origin preserves that. (Confirm daemon CORS/allow-origin accepts the new Electron origin — daemon-side, out of this file's scope.)

---

## (e) Native shims Electron's main + preload must expose

To run the existing `app/ui` unchanged, provide the following. Preload runs with
`contextIsolation` — either expose these on `window` directly (matching the current names) or
bridge via `contextBridge`; the UI reads bare `window.__EOS_*` / `window.webkit.messageHandlers.*`,
so the simplest zero-UI-change path is to define exactly those names.

**Injected globals (before app JS runs — preload):**
1. `window.__EOS_DAEMON_URL = "http://127.0.0.1:<daemonPort>"` — maps (a)/(b). Discover the port the same way the shell does (config default 7400; read `~/.eos/config.json` if you want to honor overrides).
2. `window.__EOS_UI_TOKEN = "<hex>"` — read `~/.eos/ui-token` after the daemon is healthy; maps (a)/(b) auth.
3. `document.documentElement.classList.add('native')` at document-start; toggle `.fullscreen` on Electron `enter/leave-full-screen` — maps (a) titlebar/sidebar CSS.
4. Context-menu suppression on main frame **and** the `:7401` raw subframe — maps (c) context menu.

**`window.webkit.messageHandlers.*` stand-ins (web→main commands). Provide a shim object so the existing call sites work, or the features no-op:**
5. `saveFile.postMessage({filename, base64, mimeType})` → write to Downloads (or `dialog.showSaveDialog`) — maps (c) download. *(Optional: the UI already falls back to `<a download>` which works in Chromium; you can omit this and let the fallback run.)*
6. `themeChanged.postMessage(theme)` → set BrowserWindow background color — maps (a) theme.
7. `themeSnapshot.postMessage(null)` → capture the frame, reply via `window.__eosThemeSnapshot(dataURL)` — maps (a) theme crossfade. *(Optional/cosmetic; if absent, theme.js falls back to `document.startViewTransition` or an instant apply — `theme.js:35-43`.)*
8. `pasteboardPaths.postMessage(null)` reply-handler returning `[{path,isDir}]` — maps (c) file paths from clipboard. *(In Electron, `clipboard.readImage`/reading file paths is available; or drop it and rely on Chromium `File.path`.)*
9. `titlebarDrag` / `titlebarDblClick` — only needed if you keep the JS-driven drag instead of native `-webkit-app-region: drag` (maps (a) window drag).

**Pushed-event globals (main→web). Call these via `webContents.executeJavaScript` / IPC:**
10. `window.__nativeNavigate(workerId)` on notification click / menu-bar navigate — maps (b)/(c) notifications.
11. `window.__eosNativeDrop(entries)` and `window.__eosDragState(active)` for native file drag/drop, if you intercept OS drag; otherwise rely on Chromium DnD + `File.path` — maps (c) DnD.

**Main-process behaviors (no web global, but the shell does them today — replicate or the feature disappears):**
12. Open a **second** SSE connection to `${daemon}/stream`, parse attention lines, post a native `Notification`, and on click focus the window + fire `__nativeNavigate` — maps (b)/(c) notifications (`app/main.swift:833-867`).
13. External-link handling: `setWindowOpenHandler` + `will-navigate` → `shell.openExternal` for `http/https/mailto`, block in-frame nav of the app origin — maps (c) external links (`app/main.swift:873-889`).
14. Native Edit-menu ⌘C/⌘X/⌘V/⌘A/Undo/Redo wired to `window.__eosTerm.*`, `window.__eosUndo/__eosRedo` for the terminal + composer — maps (a) clipboard/undo bridges. *(In Electron the default Edit menu + Chromium clipboard cover most of this; the terminal (xterm) still benefits from routing paste through `__eosTerm.pasteBase64` if you intercept the accelerator.)*
15. Frameless window + traffic-light insets consistent with the `html.native` CSS, plus honoring `--app-region` (CSS shim to `-webkit-app-region`, or the mousedown→`performWindowDrag` equivalent) — maps (a).

**Not needed (explicitly absent in the UI):** no `Notification` Web API usage, no `getUserMedia`/media permissions, no `window.open`/`_blank`, no `userAgent`/platform sniffing, no unix-socket use from the browser. The daemon file-picker (`pickDirectory`/`pickFiles`) already works via daemon `osascript` and needs no shell shim (optionally upgrade to Electron `dialog` for window-parented panels).

---

### One-line summary of the port surface
Inject 2 globals (`__EOS_DAEMON_URL`, `__EOS_UI_TOKEN`) + `html.native`; provide a `window.webkit.messageHandlers` shim (or let the built-in Chromium fallbacks run); re-provide 4 main-process behaviors (notifications via a second `/stream` SSE, external links, Edit-menu clipboard/undo, frameless titlebar drag). Everything else the UI does — HTTP+SSE to the daemon, the `x-eos-ui-token` header, the `/browser/stream` WebSocket, relative-base assets — is origin-agnostic and works unchanged once `__EOS_DAEMON_URL` points at the loopback daemon.
