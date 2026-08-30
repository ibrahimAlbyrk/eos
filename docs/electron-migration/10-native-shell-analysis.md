# Native shell analysis — what an Electron port must replicate 1:1

Read-only audit of the macOS WKWebView shell (`app/`). Every native capability
and window-chrome detail below must be re-provided by the Electron port for
pixel- and behaviour-parity. Citations are `file:line` into the current tree.

Files audited:
- `app/main.swift` (1177 lines) — WKWebView host, window chrome, daemon lifecycle, bridge, notifications, SSE, menu.
- `app/StatusBar/*.swift` — menu-bar status item (FleetModel, AgentStatusSource, CompletionQueue, StatusItemController, StatusBarCoordinator, AgentNavigator).
- `app/Info.plist`, `app/build.sh`.
- Web-side contract (what the bridge feeds): `app/ui/src/lib/nativeBridge.js`, `app/ui/src/components/terminal/terminalBridge.js`, `app/ui/src/settings/theme.js`, `app/ui/src/api/client.js`, `app/ui/src/App.jsx`.

Reference design: a DARK macOS window, native traffic-light controls at top-left,
web UI extending full-bleed under a transparent titlebar. The "glass" look of the
main window is painted by the **web UI CSS**, not by native vibrancy — see (a).

---

## (a) WKWebView configuration

- **Configuration object.** `WKWebViewConfiguration()` created fresh in `setupWindow` (`main.swift:267`). WebView is a custom `EosWebView` subclass (`main.swift:341`, class at `main.swift:102`) that intercepts Finder file drags — see (d)/(f).
- **Developer extras / inspector.** `cfg.preferences.setValue(true, forKey: "developerExtrasEnabled")` (`main.swift:268`) AND `webView.isInspectable = true` for macOS 13.3+ (`main.swift:345`). Both are needed on modern macOS — `developerExtrasEnabled` alone no longer opens the inspector (comment `main.swift:342-344`). Electron: `webPreferences.devTools` + open DevTools; keep always-on for the local dev app.
- **Custom URL scheme handler.** `cfg.setURLSchemeHandler(BundledUISchemeHandler(root: uiRoot), forURLScheme: "eos")` (`main.swift:274`), `uiRoot = Bundle.main.resourceURL/ui` (`main.swift:273`). Full handler analysis in (c).
- **Injected user scripts** (`WKUserScript`, all via `userContentController.addUserScript`):
  1. `window.__EOS_DAEMON_URL = '<DAEMON>'` at document-start, main frame (`main.swift:280-283`; `DAEMON = "http://127.0.0.1:7400"` at `main.swift:8`). The UI reads this because it loads from `eos://app/` and can't derive the daemon origin from `location.origin` (`client.js:11-13`).
  2. `documentElement.classList.add('native')` + a `contextmenu`→`preventDefault` suppressor, document-start, main frame (`main.swift:285-293`). The `html.native` class gates native-only CSS (drag regions etc.).
  3. A second `contextmenu` suppressor scoped to `location.port === '7401'`, document-start, **all frames** (`forMainFrameOnly: false`, `main.swift:297-306`) — reaches the raw-content subframes (HTML games, pdf.js) served on the 7401 origin.
  4. Titlebar-drag JS at document-end, main frame (`main.swift:312-329`) — see (b)/(d).
  5. Per-boot UI token: `window.__EOS_UI_TOKEN = '<hex>'` at document-start, main frame, added once in `loadWeb()` (`main.swift:490-501`). Read by the UI to authorize checkout-mutating endpoints (`client.js:84-85`).
- **Transparency / `drawsBackground` / background color.** No `drawsBackground`, no `underPageBackgroundColor`, no private `drawsTransparentBackground` are set (confirmed absent). The webview is opaque; its background is set via layer: `webView.wantsLayer = true` then `webView.layer?.backgroundColor = themeBackground(theme).cgColor` (`main.swift:347-348`). The **window** background is also set to the theme color (`main.swift:370`). Purpose: paint the correct dark/light base color *before first paint* so there is no flash (`main.swift:339`, `initialTheme()` at `main.swift:396-399`). `themeBackground` = dark `#1a1a1a` (white 0.102) / light `#f6f1e6` (`main.swift:390-394`). Electron: set `BrowserWindow backgroundColor` to the same resolved value pre-load; the window's glassy appearance itself comes from web CSS, not native.
- **Custom user-agent.** None set (no `customUserAgent` / `applicationNameForUserAgent`). Electron may leave default.
- **Content-inset behavior.** No `WKWebView` content inset API used. The webview fills the whole window including under the titlebar via `.fullSizeContentView` (see (b)); traffic lights float over web content. Electron equivalent: `titleBarStyle: 'hiddenInset'`/`'hidden'` with `trafficLightPosition`, frameless full-bleed content.
- **Cache handling at load.** `loadWeb()` clears only HTTP disk+memory caches (NOT `allWebsiteDataTypes`) so a rebuilt `dist/` loads fresh while preserving `localStorage` (`main.swift:505-512`). Load is `eos://app/index.html` with `.reloadIgnoringLocalCacheData` (`main.swift:509-510`).

**Electron must re-provide:** a custom-protocol-backed webview with DevTools on, an opaque theme-matched background set before first paint, five injected preload globals/scripts (daemon URL, `native` class + context-menu suppression, 7401-frame suppression, titlebar-drag, UI token), and cache clearing that preserves localStorage.

---

## (b) Window chrome

- **Window class.** `QuietWindow` (NSWindow subclass, `main.swift:147-152`) that swallows `keyDown` in `noResponder(for:)` so un-`preventDefault`ed keys (WASD in a game iframe, keys with nothing focused) don't trigger `NSBeep`. Electron: a `before-input-event` / no-op is usually unnecessary (Chromium doesn't beep), but verify no system beep on unhandled keys.
- **Style mask / size.** `[.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView]` (`main.swift:352`). Default content rect **1280×820** (`main.swift:351`); `minSize` **800×500** (`main.swift:369`). Window is centered (`main.swift:376`).
- **`titlebarAppearsTransparent = true`** (`main.swift:364`).
- **`titleVisibility = .hidden`** (`main.swift:365`); `window.title = "Eos"` still set (`main.swift:355`).
- **Full-size content view** via style mask above — web content extends under the titlebar.
- **Unified toolbar for a tall titlebar.** An **empty** `NSToolbar` (`titlebarToolbar`, `main.swift:220`) is attached (`window.toolbar = titlebarToolbar`, `main.swift:366`) with `toolbarStyle = .unified` (`main.swift:367`) and `titlebarSeparatorStyle = .none` (`main.swift:368`). The empty-toolbar + `.unified` combo produces a **taller titlebar** and lets AppKit natively center/inset the traffic lights (comment `main.swift:217-219`). In fullscreen the toolbar is detached so the reveal strip shows only the buttons (`main.swift:411`, restored `main.swift:416`). Electron has no direct "unified tall titlebar" equivalent — parity requires choosing a titlebar inset/height and traffic-light offset to match; see next two points.
- **Traffic-light position / handling.** `TrafficLightPositioner` (`main.swift:44-84`) nudges each standard window button **up by dy = 3 pt** (`dx = 0`, `main.swift:45-46`), moving the buttons (not their container) so hit-testing stays exact. Applied on `windowDidResize` and `windowDidBecomeKey` (`main.swift:384-385`) and after `makeKeyAndOrderFront` (`main.swift:381`). Suspended entering fullscreen, resumed on exit (`main.swift:67-83`, `410`/`417`). The target is "13px from the sidebar island's corner … the 6px `--shell-gap` inset" (comment `main.swift:38-43`). Electron: `trafficLightPosition: {x, y}` on the BrowserWindow — must be tuned to reproduce this exact offset; there is no per-key-window re-apply hook needed (Electron keeps position across resize), but fullscreen behaviour must be checked.
- **Window corner radius.** Forced to **10 pt** (`WINDOW_CORNER_RADIUS = 10`, `main.swift:9`) via `installWindowCornerRadius` (`main.swift:18-36`), which swizzles private `NSThemeFrame` methods `_cornerRadius`, `_getCachedWindowCornerRadius`, `_topCornerSize`, `_bottomCornerSize` **before first paint** (called `main.swift:375`). Reason: macOS Tahoe (26) draws large ~26pt corners for toolbar windows; no public API reduces it (comment `main.swift:11-17`). Electron/Chromium draws its own window corners on macOS — parity requires matching a ~10pt radius (Chromium's default rounded-corner radius differs; may need `roundedCorners` + verification, or a CSS-drawn frame if frameless).
- **Custom titlebar drag region.** WKWebView ignores `-webkit-app-region`, so drag is driven from JS: injected script listens for `mousedown` on an element whose computed `--app-region` is `drag` and posts `titlebarDrag` (or `titlebarDblClick` on a <400ms second click) (`main.swift:312-329`). Native handles `titlebarDrag` → `window.performDrag(with:)` using the cached last mouse-down (`main.swift:1102-1106`; cache monitor `main.swift:260-263`, field `main.swift:253`). The CSS drag strips live in the web UI (`--app-region: drag`/`no-drag`, e.g. `app/ui/src/styles.css:498,1235`; PaneHeader note `app/ui/src/views/code/panes/PaneHeader.jsx:20`). **In Electron `-webkit-app-region: drag` works natively** — but the UI currently uses the custom `--app-region` property, so the port must either map `--app-region`→`-webkit-app-region` or keep the JS-drag path.
- **Double-click titlebar action.** `handleTitlebarDoubleClick` reads the system default `AppleActionOnDoubleClick` (Maximize/Minimize/None) and zooms/miniaturizes accordingly (`main.swift:401-408`, invoked `main.swift:1108`). Electron must replicate reading the same macOS preference for parity (default = zoom).
- **Fullscreen hooks.** `windowWillEnterFullScreen`/`windowDidExitFullScreen` toggle `documentElement.classList` `fullscreen`, detach/reattach the toolbar, suspend/resume traffic lights (`main.swift:409-419`).
- **Window frame persistence.** `setFrameAutosaveName("Eos")` (`main.swift:378`). Electron: persist/restore bounds manually.
- **Background-app window semantics.** `isReleasedWhenClosed = false` (`main.swift:360`) — closing the window keeps it reusable (see (e), product decision #1).

**Electron must re-provide:** frameless/`hiddenInset` window, 1280×820 default / 800×500 min, transparent titlebar with hidden title, a taller titlebar inset that matches the empty-unified-toolbar height, traffic lights offset to the exact design spot, ~10pt window corners, a JS/CSS drag region honoring `--app-region`, double-click-to-zoom honoring the system pref, fullscreen class toggling, and window-frame persistence.

---

## (c) `eos://` custom URL scheme handler

`BundledUISchemeHandler: WKURLSchemeHandler` (`main.swift:158-212`).

- **Why a custom scheme, not `file://`.** `file://` pages get an opaque origin with unreliable `localStorage`; the UI persists input history / active view / scroll positions there, so a stable `eos://app/` origin is required (comment `main.swift:154-157`).
- **Root.** `Bundle.main.resourceURL/ui` (`Contents/Resources/ui`), standardized (`main.swift:161-163`, set from `main.swift:273`).
- **Resolution.** `start(task:)` (`main.swift:166-191`): take `url.path`; empty or `/` ⇒ `/index.html` (`main.swift:170-171`); resolve under root and **standardize** (`main.swift:172`).
- **Path-traversal guard.** Serve only if `fileURL.path == root.path` or has prefix `root.path + "/"` (`main.swift:174`) — else 404. Electron: replicate with a normalized-path containment check in the `protocol.handle`/`registerFileProtocol` callback.
- **Responses.** 200 with `Content-Type` (from extension) + `Content-Length`; body is the full file `Data` (`main.swift:183-190`). Missing/oob ⇒ 404 `text/plain` "not found" (`main.swift:176-181`).
- **MIME map** (`main.swift:195-211`): html, js/mjs, css, json/map, svg, png, jpg/jpeg, gif, webp, woff2, woff, ico, else `application/octet-stream`.
- **Range / SSE handling.** **None.** The whole file is read synchronously into memory and returned in one `didReceive(data)`; there is no `Range`/`Accept-Ranges`/partial-content or streaming (`stop` is a no-op, `main.swift:193`). SSE is not served here at all — SSE is a separate cross-origin connection to the daemon (see (e)). Electron note: Chromium's `<video>`/media may request `Range`; the custom protocol should still work for the SPA assets, but if any media is loaded from `eos://` add range support.

**Electron must re-provide:** a registered `eos://app/` scheme (standard scheme, secure/streaming registered before app-ready) that maps requests to files under the packaged UI dir, with the same default-to-index, containment guard, and MIME map. Registering it as a *standard, secure* scheme is important to keep a stable origin + working localStorage/fetch.

---

## (d) Native ↔ JS bridge

### JS → native: `WKScriptMessageHandler` names (registered `main.swift:330-335`)

One-way handlers via `userContentController.add(self, name:)` → handled in `userContentController(_:didReceive:)` (`main.swift:1056-1109`):

1. **`titlebarDblClick`** (`main.swift:330`) — posted by injected titlebar JS on a double drag-click; falls through to `handleTitlebarDoubleClick(nil)` (`main.swift:1108`). Effect: zoom/minimize/none per `AppleActionOnDoubleClick`.
2. **`titlebarDrag`** (`main.swift:331`) — posted on drag mousedown; calls `window.performDrag(with:)` with the cached mouse-down (`main.swift:1102-1106`).
3. **`themeChanged`** (`main.swift:332`) — body = resolved theme string `"dark"/"light"` (posted at `theme.js:20`). Persists to `UserDefaults` key `EosTheme` and repaints webview layer + window bg (`main.swift:1093-1100`). Note: native never sets `window.appearance` — that would freeze `prefers-color-scheme` inside the webview (comment `main.swift:387-389`).
4. **`themeSnapshot`** (`main.swift:333`) — request to freeze the current frame for the JS circular theme-reveal. Native calls `webView.takeSnapshot` and hands a JPEG data URL back via `window.__eosThemeSnapshot(...)` (`main.swift:1074-1091`). Posted at `theme.js:103`; consumed at `theme.js:55-101`.
5. **`saveFile`** (`main.swift:334`) — body `{filename, base64, mimeType}` (posted at `client.js:816`). Native decodes base64 and **writes directly to `~/Downloads`**, then `NSWorkspace.open`s it (`main.swift:1056-1073`). Note: **no `NSSavePanel`** — it is a silent write-to-Downloads-then-open, used because WKWebView on the `eos://` scheme doesn't support `<a download>` (`client.js:814`).

Reply-style handler via `addScriptMessageHandler(self, contentWorld: .page, name:)` → `userContentController(_:didReceive:replyHandler:)` (`main.swift:1050-1054`):

6. **`pasteboardPaths`** (`main.swift:335`) — Cmd+V path lookup. Returns `[{path, isDir}]` read from `NSPasteboard.general` (`main.swift:1053`, helper `pasteboardFileEntries` at `main.swift:89-97`). Consumed at `nativeBridge.js:13-22`. Electron: expose an equivalent `ipcRenderer.invoke` reading clipboard file paths (or `webUtils`/native clipboard).

Bridge globals the UI expects to exist (must be provided by Electron preload): `window.__EOS_DAEMON_URL` (`client.js:11-13`), `window.__EOS_UI_TOKEN` (`client.js:84-85`, `browserPanelStore.js:88`), `window.__eosTerm` (`terminalBridge.js:39-57`), `window.__eosUndo`/`__eosRedo` (`useContentEditableEditor.js:285-286`), `window.__eosNativeDrop`/`__eosDragState` (`nativeBridge.js:27-32`), `window.__eosThemeSnapshot` (`theme.js:55`), `window.__nativeNavigate` (`App.jsx:33-34`), plus the `webkit.messageHandlers.*` handlers 1–6 above (or a shimmed equivalent).

### Native → JS: every `evaluateJavaScript` call

From `main.swift` (plus one in AgentNavigator):

| Site | JS invoked | Purpose |
|---|---|---|
| `main.swift:113` | `window.__eosDragState?.(true)` | Finder drag entered — show composer drop UI (`nativeBridge.js:30`) |
| `main.swift:124` | `window.__eosDragState?.(false)` | Finder drag exited |
| `main.swift:134` | `window.__eosDragState?.(false)` | drag ended (drop) |
| `main.swift:139` | `window.__eosNativeDrop?.(<json>)` | deliver dropped `[{path,isDir}]` to composer (`nativeBridge.js:27`) |
| `main.swift:412` | `documentElement.classList.add('fullscreen')` | fullscreen enter |
| `main.swift:418` | `documentElement.classList.remove('fullscreen')` | fullscreen exit |
| `main.swift:809` | `window.__nativeNavigate?.('<wid>')` | notification tap → jump to worker (`App.jsx:33`) |
| `main.swift:988` | `window.__eosUndo?.()` | ⌘Z → composer undo stack |
| `main.swift:989` | `window.__eosRedo?.()` | ⌘⇧Z → composer redo |
| `main.swift:998` | `window.__eosTerm?.getSelectionIfFocused() ?? null` | ⌘C: read xterm selection, else fall through to native copy |
| `main.swift:1011` | `window.__eosTerm?.getSelectionIfFocused() ?? null` | ⌘X (terminal read-only ⇒ copy) |
| `main.swift:1023` | `window.__eosTerm?.isFocused() === true` | ⌘V: is terminal focused? |
| `main.swift:1030` | `window.__eosTerm.pasteBase64('<b64>')` | paste NSPasteboard bytes into xterm |
| `main.swift:1038` | `window.__eosTerm?.isFocused() === true` | ⌘A: terminal focused? |
| `main.swift:1041` | `window.__eosTerm.selectAll()` | select-all in xterm |
| `main.swift:1084` | `window.__eosThemeSnapshot(null)` | snapshot failed → bail the theme fade |
| `main.swift:1088-1089` | `window.__eosThemeSnapshot('data:image/jpeg;base64,…')` | deliver frozen frame for theme reveal |
| `AgentNavigator.swift:36` | `window.__nativeNavigate?.('<id>')` | status-bar/programmatic focus of an agent |

Also native-only: **`webView.takeSnapshot`** (`main.swift:1077`) to produce the theme-transition JPEG (a WKWebView capability; Electron: `webContents.capturePage()`).

**Electron must re-provide:** the six inbound channels (as `ipcRenderer.postMessage`/`invoke`), and outbound `webContents.send`/`executeJavaScript` calls to drive the 8 distinct JS globals above. The whole terminal-clipboard dance exists because AppKit's Edit menu consumes ⌘C/X/V/A before WebKit sees them (comment `main.swift:991-996`); in Electron the menu/roles interplay differs — decide whether to keep JS-routed clipboard or use native roles + xterm's own handlers.

---

## (e) Native OS integrations

- **Menu-bar status item (StatusBar/).** A retained `NSStatusItem` of `variableLength` (`StatusItemController.swift:315`), owned for process lifetime (`statusBar` field `main.swift:247`; `setupStatusBar` `main.swift:926-939`). It hosts a **custom `BarStatusView`** (`StatusItemController.swift:113-295`) that renders two faces: a breathing "dawn-star" icon with a running-agent count (`renderIcon` `:211-233`, animator `:81-107`), and a completion "pill" that announces `name done/failed` with a draining underline and a `+N` overflow badge (`renderPill` `:235-281`). Interaction: **left-click opens the main window**, **right/ctrl-click shows a menu** (Open Eos / Quit Eos) (`statusClicked` `:365-372`, `showMenu` `:376-388`). Data flow: `SSEAgentStatusSource` opens its **own** `/stream` SSE reader + a 4s `/workers` poll (`AgentStatusSource.swift:20-170`), diffed by a pure `FleetReducer` (`FleetModel.swift:87-119`) into completions played by a `CompletionQueue` ticker (`CompletionQueue.swift:38-111`); wired in `StatusBarCoordinator` (`StatusBarCoordinator.swift:23-67`). Colors adapt to light/dark menu bar (`BarPalette` `StatusItemController.swift:19-41`); animation respects Reduce Motion (`:88`, `:285`). Electron: a `Tray` with a rendered `nativeImage` (Electron trays can't host a live CADisplayLink view — the breathing star + drain animation must be reproduced by pushing pre-rendered frames or template images on a timer), a context menu, and left-click→show-window. Reproducing the animated custom-drawn star at parity is the hardest StatusBar item.
- **Notifications.** `UNUserNotificationCenter`, authorization for `[.alert, .sound, .badge]` (`main.swift:793-801`). Presented as `[.banner, .sound]` even when foreground would suppress — actually only fired when the app is **not active** (`main.swift:865-867`). Tap → activate app, show window, `window.__nativeNavigate(workerId)` (`main.swift:803-812`). Content carries `userInfo["workerId"]` (`main.swift:820-829`). Trigger source: SSE frames with `reason == "notification:fire"` on the daemon `/stream`, parsed off-main (`handleSSELine` `main.swift:851-869`). Electron: `Notification` API + a main-process SSE consumer of `/stream`; replicate the "only when not focused" gate and the click→navigate.
- **Global shortcuts / hotkeys.** **None.** No `globalShortcut`-style registration anywhere. Only **app-menu key equivalents** (local, main-window scoped): About/Quit ⌘Q (`main.swift:1130-1134`), Edit ⌘Z/⌘⇧Z/⌘X/⌘C/⌘V/⌘A routed to custom `eos*` selectors (`main.swift:1139-1159`), View Reload ⌘R (`main.swift:1164`), Window Minimize ⌘M / Zoom (`main.swift:1171-1172`). Electron: build the same `Menu` with these accelerators; do **not** add global shortcuts.
- **Dock.** App is a background app but **`LSUIElement` is NOT set** (absent from `Info.plist`) → it **does** show in the Dock. `applicationShouldTerminateAfterLastWindowClosed = false` (`main.swift:901`); Dock-click / reopen re-shows the window via `applicationShouldHandleReopen` → `ensureMainWindowVisible` (`main.swift:919-922`, `941-945`). Electron: `app.on('activate')` re-creates/shows the window; don't quit on `window-all-closed` (macOS); no `app.dock.hide()`.
- **File open/save dialogs.** **No `NSOpenPanel`/`NSSavePanel` at all.** "Save" is the `saveFile` handler writing straight to `~/Downloads` then opening it (`main.swift:1062-1068`). File *input* comes only via Finder drag/drop and Cmd+V path bridging (see (d)/(f)). Electron: either keep silent-save-to-Downloads or (better UX) use `dialog.showSaveDialog`; must preserve the current no-dialog behaviour if parity is strict.
- **Keychain / secure storage.** **None.** The only secret, the per-boot UI token, is read from the plaintext file `~/.eos/ui-token` (`main.swift:491-494`, `612-617`), validated as lowercase hex. No Keychain APIs. Electron: read the same file; do not introduce `safeStorage` unless intended.
- **Deep links / URL handling.** **No app-level URL scheme** — `Info.plist` has no `CFBundleURLTypes`; `eos://` is only the internal WKWebView scheme, not an OS-registered handler. External links (non-`eos`, non-`127.0.0.1`) from `linkActivated` navigations open in the system browser via `NSWorkspace.shared.open` (`main.swift:873-889`); in-app `eos://` link activations are cancelled (the markdown preview intercepts them in JS). Electron: intercept `will-navigate`/`setWindowOpenHandler` to `shell.openExternal` for external URLs and block full-frame navigation of the SPA origin.
- **Launch-at-login.** **None.** No `SMAppService`/login-item registration. Electron: only add `app.setLoginItemSettings` if explicitly wanted (currently absent).
- **AppleScript.** **None.**
- **Process spawning of the daemon.** `spawnDaemon` runs the daemon when `/health` is down (`main.swift:423-459`): `/bin/bash -c 'ulimit -Sn "$(ulimit -Hn)"; exec /usr/bin/env node --no-warnings --experimental-strip-types <repo>/manager/daemon.ts'` (`main.swift:447-449`). The `ulimit` bump is essential — the GUI launch soft fd limit is 256, too low for a PTY/watch supervisor, and exhausting it breaks child spawns with EBADF/EMFILE (comment `main.swift:439-446`). stdout/stderr → `~/.eos/logs/daemon.log` (`main.swift:451-453`, `461-471`). Health is polled up to 40×0.25s (`main.swift:458`, `473-483`). `repoRoot()` resolves from the executable path (6 dirs up) or `EOS_REPO_ROOT` / baked `EosRepoRoot` Info.plist key (`main.swift:780-789`; key written by `build.sh:25`). Electron (Node main process) can spawn directly with `child_process`, but **must replicate the soft-fd-limit raise** (e.g. `posix.setrlimit` via a native addon or the same `bash -c ulimit` wrapper) and the log redirection.
- **Auto-update on launch.** A whole update flow: confirm daemon healthy → check `/api/updates/status` → if available show a **glass splash window** and POST `/api/updates/apply`, poll `/health` `sourceStamp` until the rebuilt daemon returns, then reload in place or **relaunch the app** if the bundle binary changed (`main.swift:515-628`). Relaunch = detached `/bin/sh -c 'sleep 0.6; open <bundle>'` + `NSApp.terminate` (`main.swift:619-628`). The splash uses **real Liquid Glass `NSGlassEffectView` on macOS 26**, else a masked `NSVisualEffectView` (`main.swift:636-743`). Electron: this is app-specific; parity requires an equivalent splash + update-apply/relaunch orchestration (Electron `autoUpdater` is unrelated — the update is driven by the daemon's own build).
- **Other native touches:** local `NSEvent` monitor caching left-mouse-down for `performDrag` (`main.swift:260-263`); `NSApp.activate(ignoringOtherApps:)` on show/notify/navigate; `applicationWillTerminate` posts `/workers/archived/app-closed` with a bounded 2s wait so the request reaches the daemon before exit (`main.swift:908-917`); `UserDefaults` keys `EosTheme` and window-frame autosave (`main.swift:378`, `1095`).

**NSVisualEffectView vibrancy note (for (a)/(b) too):** native vibrancy is used **only in the splash window** — `< macOS 26` fallback: `material = .popover`, `blendingMode = .behindWindow`, `state = .active`, rounded via a `maskImage` (`main.swift:729-736`); macOS 26 uses `NSGlassEffectView(cornerRadius:30, tintColor: white 0 alpha 0.10)` (`main.swift:717-724`). The **main window uses no NSVisualEffectView** — its glass/blur is entirely web CSS `backdrop-filter`. Electron parity: the main window needs no `vibrancy:`; the splash (if kept) needs a `vibrancy`/`visualEffectState` or a CSS-glass borderless window.

---

## (f) WKWebView sandbox restrictions motivating the Electron move

Concrete, evidenced friction the current shell works around — each is something Electron removes or makes easier:

1. **No absolute file paths to JS.** `clipboardData`/`dataTransfer` carry blob copies; a dragged folder surfaces as an unreadable typeless `File` (comment `main.swift:86-88`, `nativeBridge.js:1-6`). Forced a native `NSPasteboard` bridge for Cmd+V (`pasteboardPaths`, `main.swift:1050-1054`) and AppKit-level Finder drag interception (`EosWebView` `main.swift:99-142`). Electron exposes `File.path` / `webUtils.getPathForFile` and `webContents` drag events — the whole interception layer collapses.
2. **`navigator.clipboard.readText` is permission-gated in WKWebView.** So terminal paste reads `NSPasteboard` natively and hands base64 bytes to xterm (comment `main.swift:1027-1030`). Electron `clipboard.readText()` is unrestricted in the main process.
3. **No `<a download>` on the `eos://` scheme.** Forced the `saveFile` write-to-Downloads bridge (`client.js:814`, `main.swift:1056-1073`). Electron `dialog.showSaveDialog` / `session.on('will-download')` handle downloads natively.
4. **`file://` gives an opaque origin with unreliable `localStorage`.** Forced the custom `eos://app/` scheme purely to get a stable origin for persistence (comment `main.swift:154-157`). Electron standard-scheme registration solves this cleanly (and Electron could even use `file://` with `webSecurity` tuning), but the scheme should be kept for origin stability.
5. **WKWebView ignores `-webkit-app-region`.** Window drag/double-click had to be re-implemented in JS→native (`main.swift:307-329`, `1102-1108`). **Electron supports `-webkit-app-region: drag` natively** — a direct win.
6. **`takeSnapshot` doesn't bake `backdrop-filter` into pixels.** The theme-fade must re-apply the modal scrim blur live over the frozen frame (comment `theme.js:70-72`). Electron `capturePage()` composites the rendered layer (Chromium) — the backdrop-filter is captured, removing the workaround.
7. **Web Inspector gated behind `isInspectable` (macOS 13.3+).** DevTools friction (`main.swift:342-345`). Electron DevTools are always available.
8. **Cross-origin daemon access.** UI at `eos://app` can't derive the daemon URL from `location.origin`; it must be injected (`main.swift:277-283`), and API/SSE calls are cross-origin to loopback (relies on `NSAllowsLocalNetworking`, `Info.plist:25-29`). Electron: same injection still simplest, but `webSecurity`/session control give more options.
9. **Context-menu suppression** needed via injected scripts in both main and subframes (`main.swift:285-306`). Electron: `webContents.on('context-menu')` in one place.
10. **Unhandled-key `NSBeep`.** Required the `QuietWindow` subclass (`main.swift:147-152`). Chromium doesn't beep — the subclass is unneeded.
11. **Window corner radius + traffic-light placement need private/awkward AppKit.** Private `NSThemeFrame` swizzling for 10pt corners (`main.swift:18-36`) and per-key-window button re-positioning (`main.swift:44-84`). These are chrome-fidelity concerns Electron addresses with `roundedCorners` + `trafficLightPosition` (though matching the exact radius/offset still needs tuning).
12. **GUI-launch fd soft limit (256).** The daemon must be spawned through a `bash -c ulimit` wrapper (`main.swift:439-449`). An Electron Node main process must apply the same rlimit raise before spawning the daemon.

---

## Summary — per-category checklist for the Electron port

- **(a) WebView config:** custom-protocol webview, DevTools on, opaque theme-matched bg pre-paint (`#1a1a1a`/`#f6f1e6`), 5 injected preload globals/scripts (daemon URL, `native` class + context-menu suppress, 7401-frame suppress, titlebar-drag, UI token), cache clear preserving localStorage. No custom UA, no content inset, no native transparency (glass is web CSS).
- **(b) Window chrome:** frameless/`hiddenInset`, transparent titlebar, hidden title, 1280×820 default / 800×500 min, tall-titlebar inset matching the empty unified toolbar, traffic lights nudged to the design spot, ~10pt corners, `--app-region` drag + system-pref double-click-zoom, fullscreen class toggle, frame persistence, background-app close semantics.
- **(c) `eos://` scheme:** standard+secure scheme mapping to the packaged UI dir; default→`index.html`; path-containment guard; the exact MIME map; full-file responses (add Range only if media loads from `eos://`); no SSE here.
- **(d) Bridge:** 6 inbound channels (`titlebarDrag`, `titlebarDblClick`, `themeChanged`, `themeSnapshot`, `saveFile`, reply-style `pasteboardPaths`) + 18 outbound `executeJavaScript` sites driving 8 JS globals (`__eosDragState`, `__eosNativeDrop`, `__nativeNavigate`, `__eosUndo/__eosRedo`, `__eosTerm.*`, `__eosThemeSnapshot`, `fullscreen` class) + `capturePage` for the theme snapshot.
- **(e) OS integrations:** animated Tray with count/completion ticker + Open/Quit menu and left-click→show; `/stream`-driven Notifications with click→navigate (only when unfocused); app-menu accelerators (no global shortcuts); Dock-visible background app with reopen→show; silent save-to-Downloads (no dialogs); plaintext `~/.eos/ui-token` (no Keychain); external links→`openExternal` (no app URL scheme); no launch-at-login; daemon spawn with **fd-limit raise** + log redirection; launch-update splash + apply/relaunch flow.
- **(f) Sandbox wins to reclaim:** native file paths, unrestricted clipboard, native downloads, native app-region drag, backdrop-filter-correct page capture, always-on DevTools, one-place context-menu handling, no key-beep. Keep the fd-limit raise and origin-stable custom scheme.
