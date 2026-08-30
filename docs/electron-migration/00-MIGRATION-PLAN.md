# Eos → Electron — Migration Plan (definitive)

> **Status note (post-M6 consolidation):** the Swift shell has been retired and the
> Electron package now lives at **`app/`** (formerly `app-electron/`), with the React
> UI nested at `app/ui/`. Path references to `app-electron/` and to the Swift files
> (`app/main.swift`, `app/StatusBar/`, `app/Info.plist`, `app/build.sh`) in the prose
> below are historical — the code/config no longer point at them.

Synthesized 2026-08-29 from the three findings docs in this directory:

- **doc 10** — `10-native-shell-analysis.md` (Swift/WKWebView shell audit, `file:line` cites into `app/`)
- **doc 20** — `20-web-daemon-contract.md` (what `app/ui` assumes of the shell + daemon)
- **doc 30** — `30-electron-research.md` (cited Electron 42.10.1 capabilities + 10 GAPs)

Every design decision below traces to a cited point in those docs. Where doc 30's
generic research conflicts with the actual app in docs 10/20, **the actual app wins**
— each such conflict is called out inline as **CONFLICT** and collected in §I.

---

## A. Executive summary + hard constraints

### The plan in four sentences

Build a new **`app-electron/`** package beside `app/` that re-provides the Swift
shell's exact surface: an `eos://app/` privileged custom scheme serving the same
`app/ui/dist` bundle, a preload that injects the identical `__EOS_*` globals and a
`window.webkit.messageHandlers` shim, and a main process that replicates the six
inbound bridge channels, the 18 outbound `evaluateJavaScript` drivers, the Tray, the
notification SSE consumer, the daemon spawn (with the fd-limit bump), and the
splash/auto-update flow. The main window is an **opaque, theme-painted
`titleBarStyle:'hiddenInset'` window with NO native vibrancy** — the glass look
stays in web CSS exactly as today (doc 10 §a, §(e) vibrancy note). The React app in
`app/ui` runs **unchanged** except one additive CSS tweak (real
`-webkit-app-region` next to the existing `--app-region` custom property — §D4),
justified below. Cutover is phased (M0–M7, §H), each milestone with a checkable
gate, ending in an A/B screenshot parity audit against the Swift app; `app/build.sh`
and the Swift shell keep working throughout.

### Hard constraints (restated, binding on every section)

1. **PIXEL-PERFECT design fidelity is rule #1.** The main window's look is the WEB
   layer: opaque theme-matched background painted before load + CSS "glass"
   (`backdrop-filter`), NOT native vibrancy. Native `NSVisualEffectView` exists
   only in the update splash (doc 10 §e vibrancy note). The Electron main window
   must reproduce: opaque pre-paint (`#1a1a1a` dark / `#f6f1e6` light, doc 10 §a),
   `titleBarStyle:'hiddenInset'` + transparent titlebar + hidden title + full-size
   content, the exact traffic-light offset (native nudges buttons **+3 pt up**,
   doc 10 §b), **~10 pt window corner radius** (doc 10 §b), tall-titlebar sizing
   (empty-unified-toolbar height), and the drag behavior driven by the UI's
   `--app-region` CSS. **Do NOT set `vibrancy` on the main window** — Electron
   forces vibrancy always-active (doc 30 Diff A) and native vibrancy composes
   badly with CSS `backdrop-filter` (doc 30 Diff B); either would change the look.
2. **Optimized & performant:** `backgroundThrottling:false` on the live SSE window
   (doc 30 Claim 3.1), deferred startup work (doc 30 Claim 3.4), single bundled
   main file (doc 30 Claim 3.6), `contextIsolation:true` + `sandbox:true` +
   `nodeIntegration:false` (doc 30 Claims 4.1–4.4), narrow `contextBridge` preload
   (doc 30 Claim 4.5).
3. **Zero (or near-zero) changes to `app/ui`.** The UI detects the shell purely by
   capability — presence of `window.webkit.messageHandlers.*`, `__EOS_*` globals,
   and the `html.native` class; no UA sniffing exists (doc 20 preamble). Electron
   main+preload re-provide exactly those names so the same code paths light up.
   The single proposed UI change is listed in §D4 with justification; everything
   else is shell-side.

### Headlines

- **Feature parity:** all 6 inbound bridge channels, all 8 outbound JS globals
  (18 call sites), Tray, notifications, daemon spawn, splash/update — each mapped
  to a concrete Electron mechanism in §E. Eight WKWebView workarounds become
  obsolete (real file paths, `<a download>`, native app-region drag, no key-beep,
  composited `capturePage`, always-on DevTools, one-place context menu,
  unrestricted clipboard read) but their shims are kept where the UI calls them.
- **Roadmap:** M0 scaffold → M1 scheme+daemon → M2 window chrome (incl. the two
  chrome spikes: corner radius, traffic-light offset) → M3 bridge parity →
  M4 Tray+notifications → M5 splash/update → M6 packaging/signing → M7 A/B
  parity audit + cutover decision.
- **Top risks (full list §I):** (1) 10 pt corner radius has no public Electron
  API — Swift needed private `NSThemeFrame` swizzling; may need a tiny native
  addon or an accepted delta. (2) Tall-titlebar/traffic-light geometry has no
  unified-toolbar equivalent — pure `trafficLightPosition` tuning + measurement.
  (3) The animated Tray star/pill can't host a live view — frame-pushed
  `nativeImage` rendering, the single largest re-implementation. (4) WebKit→
  Chromium font rasterization differs subtly — "pixel-perfect" is scoped to
  chrome/layout/color, verified by the §D9 protocol. (5) Electron has no
  programmatic window-drag API — drag must come from real `-webkit-app-region`
  CSS, hence the one UI change.

---

## B. Current architecture recap (from docs 10/20)

### The shell (doc 10)

`app/main.swift` (1177 lines) + `app/StatusBar/*.swift` host a WKWebView:

- **Window:** `QuietWindow` (swallows unhandled-key beep), style
  `[titled, closable, miniaturizable, resizable, fullSizeContentView]`, 1280×820
  default / 800×500 min, centered, `titlebarAppearsTransparent`,
  `titleVisibility=.hidden`, an **empty unified `NSToolbar`** attached purely to
  get a taller titlebar with AppKit-centered traffic lights, buttons then nudged
  **+3 pt up** by `TrafficLightPositioner`, corner radius forced to **10 pt** via
  private `NSThemeFrame` swizzling (macOS Tahoe otherwise draws ~26 pt), frame
  autosaved under "Eos", `isReleasedWhenClosed=false` (doc 10 §b).
- **WebView:** opaque; layer + window background set to the theme color
  (`#1a1a1a`/`#f6f1e6`) *before first paint*; DevTools enabled; five injected
  user scripts: `__EOS_DAEMON_URL`, `html.native` class + context-menu
  suppression, a second suppressor for `:7401` subframes, titlebar-drag JS, and
  the per-boot `__EOS_UI_TOKEN` (doc 10 §a). Reload clears only HTTP caches,
  preserving localStorage (doc 10 §a).
- **`eos://` scheme:** `BundledUISchemeHandler` serves `Contents/Resources/ui`
  with default-to-`index.html`, a path-containment guard, a fixed MIME map, whole
  files in one response — no Range, no SSE (doc 10 §c). The scheme exists because
  `file://` gives an opaque origin with unreliable localStorage (doc 10 §f4).
- **Bridge:** 6 inbound `WKScriptMessageHandler`s (`titlebarDrag`,
  `titlebarDblClick`, `themeChanged`, `themeSnapshot`, `saveFile`, reply-style
  `pasteboardPaths`) and 18 outbound `evaluateJavaScript` sites driving 8 UI
  globals (`__eosDragState`, `__eosNativeDrop`, `__nativeNavigate`,
  `__eosUndo/__eosRedo`, `__eosTerm.*`, `__eosThemeSnapshot`, the `fullscreen`
  class) plus `takeSnapshot` for the theme crossfade (doc 10 §d).
- **OS integration:** animated menu-bar status item (breathing dawn-star + running
  count, completion pill with draining underline and `+N` badge, own SSE reader +
  4 s poll, left-click opens window, right-click menu); `UNUserNotification`s
  fired from the shell's **own** `/stream` SSE consumer only when the app is not
  active, tap → `__nativeNavigate(workerId)`; app-menu-only accelerators (no
  global shortcuts); Dock-visible background app, reopen → show; silent
  save-to-Downloads (no NSSave/OpenPanel); plaintext `~/.eos/ui-token` (no
  Keychain); external links → system browser; **no** app-level URL scheme, **no**
  launch-at-login, **no** AppleScript; daemon spawned through
  `bash -c 'ulimit -Sn "$(ulimit -Hn)"; exec … node … manager/daemon.ts'` with
  logs to `~/.eos/logs/daemon.log` (GUI soft fd limit 256 is too low for the PTY
  supervisor); launch-time update flow with a glass splash, `/api/updates/apply`,
  `sourceStamp` polling, and app relaunch; `applicationWillTerminate` posts
  `/workers/archived/app-closed` with a bounded 2 s wait (doc 10 §e).

### The web/daemon contract (doc 20)

- UI is **not served by the daemon**; it loads from `eos://app/` and reaches the
  daemon **cross-origin** over loopback: HTTP + SSE `/stream?clientId=` at
  `__EOS_DAEMON_URL` (fallback `http://127.0.0.1:7400`), raw sandbox content on a
  hardcoded-`+1` origin `http://127.0.0.1:7401`, and the browser-panel WebSocket
  `/browser/stream?uiToken=` (doc 20 §b).
- Auth is a single per-boot token sent as `x-eos-ui-token` on privileged
  endpoints (query param on the WS); no cookies, no CSRF (doc 20 §b).
- The UI's SSE wrapper does its own exponential-backoff reconnect (doc 20 §b).
- Detection is capability-based everywhere; ~30 CSS rules key on `html.native`;
  `--app-region: drag|no-drag` is a *custom property* read by injected shell JS
  because WKWebView ignores `-webkit-app-region` (doc 20 §a).
- Vite builds with `base:"./"` (relative assets, scheme-agnostic); durable
  settings live daemon-side via `/settings`; localStorage holds only ephemeral UI
  state (doc 20 §c/§d).
- File pickers already go through daemon `osascript` routes — no shell dependency
  (doc 20 §c).

---

## C. Target Electron architecture

Pinned **Electron 42.10.1** (Chromium 148, Node 24.18.1), explicit in
`package.json` — majors move every ~8 weeks (doc 30 version pin).

### C1. Process model

- **One main process** (single bundled file, doc 30 Claim 3.6): window + scheme
  + daemon lifecycle + bridge endpoints + Tray + notifications + menu + updates.
- **One renderer** (one `BrowserWindow` = one renderer, doc 30 Claim 3.8) running
  the unchanged `app/ui` bundle, `sandbox:true` + `contextIsolation:true` +
  `nodeIntegration:false` (doc 30 §4). The `:7401` raw-content iframes are
  cross-origin subframes inside the same window (site isolation may give them
  their own OS processes — accepted, see §I-R14).
- **One preload** (also single-file bundled) exposing the shim surface in §C4 via
  `contextBridge.exposeInMainWorld` (doc 30 Claim 4.5).
- **The splash** is a second, tiny `BrowserWindow` that exists only during the
  launch-update path (§D8).

### C2. Asset serving — the `eos://app/` scheme, kept

Decision: **keep the same scheme name and origin `eos://app`** so the UI's
origin-coupled behaviors are untouched — the markdown relative-href workarounds
(`mdLinkResolve.js:3`, `useMarkdownLinks.js:45`) resolve against the same origin
string, and `client.js`'s "origin is not the daemon" assumption holds verbatim
(doc 20 §a "eos://app/ origin assumptions").

- Before `app.ready`, once (doc 30 Claim 2.2):

  ```js
  protocol.registerSchemesAsPrivileged([{
    scheme: "eos",
    privileges: { standard: true, secure: true, supportFetchAPI: true,
                  stream: true, codeCache: true },
  }]);
  ```

  `standard` gives relative-URL resolution + a real origin (replacing WKWebView's
  scheme registration, doc 10 §c "standard, secure … stable origin"); `secure`
  targets a secure context — **verify `window.isSecureContext===true` at runtime,
  it is doc-thin** (doc 30 GAP 5).
- After ready, `protocol.handle("eos", handler)` (doc 30 Claim 2.1) replicating
  `BundledUISchemeHandler` exactly (doc 10 §c):
  - root = the packaged `app/ui/dist` directory (dev: `../app/ui/dist`);
  - empty path or `/` → `/index.html`;
  - **containment guard**: resolve + normalize, serve only if the real path equals
    the root or starts with `root + "/"`, else 404 `text/plain` "not found";
  - the same MIME map (html, js/mjs, css, json/map, svg, png, jpg/jpeg, gif,
    webp, woff2, woff, ico → else `application/octet-stream`);
  - whole-file `Response` bodies. **No Range support initially** — the Swift
    handler has none and no media loads from `eos://` today; audit `dist/` at M1
    and add Range only if media appears (doc 10 §c note, doc 30 GAP 3).
  - Bonus over Swift: the `index.html` response can carry a **CSP header** here
    (defense-in-depth without touching the HTML — doc 30 Claim 2.5 suggests a
    `<meta>` tag; a header from `protocol.handle` achieves it with zero UI change).
- **Daemon traffic stays on plain `http://127.0.0.1`** — fetch/EventSource/WS
  directly from the renderer exactly as today. SSE and Range over a custom scheme
  are undocumented (doc 30 GAP 3/4); doc 30's own recommendation is to serve only
  static assets via the scheme. This also keeps the CORS/token model identical
  (doc 20 §d) — the daemon already answers a non-http `eos://app` origin today;
  M1's gate confirms the Chromium-sent `Origin` header is accepted unchanged.

### C3. Daemon lifecycle (spawn, fd limit, token, health)

Replicates `spawnDaemon` (doc 10 §e):

1. Probe `GET /health`; if down, spawn:

   ```js
   spawn("/bin/bash", ["-c",
     `ulimit -Sn "$(ulimit -Hn)"; exec /usr/bin/env node --no-warnings ` +
     `--experimental-strip-types "${repoRoot}/manager/daemon.ts" ` +
     `>> "${home}/.eos/logs/daemon.log" 2>&1`
   ], { detached: true, stdio: "ignore" }).unref();
   ```

   The **`ulimit` bump is mandatory** — a GUI-launched process gets a soft fd
   limit of 256, too low for the PTY/watch supervisor; exhaustion breaks child
   spawns with EBADF/EMFILE (doc 10 §e, §f12). The `bash -c` wrapper is the
   proven mechanism; keep it rather than a native `setrlimit` addon. Log
   redirection moves into the same wrapper (Swift used FileHandles; the shell
   redirect is equivalent and simpler).
2. `repoRoot` resolution: `EOS_REPO_ROOT` env override, else a baked value —
   Swift bakes `EosRepoRoot` into Info.plist via `build.sh` (doc 10 §e); the
   Electron equivalent is a value stamped into the bundled main (or Forge
   `extraResource` config) at build time, with the same env override.
3. Poll `/health` up to 40 × 0.25 s (doc 10 §e).
4. Only after healthy: read `~/.eos/ui-token`, validate lowercase hex
   (doc 10 §e "Keychain" — it is a plaintext file, **CONFLICT** with doc 30
   Claim 5.5's `safeStorage` suggestion; actual app wins: read the same file, do
   not introduce Keychain storage, the daemon owns that file's lifecycle).
5. Then create the window and load `eos://app/index.html`.

### C4. Preload / contextBridge API surface (complete)

The UI reads bare `window.__EOS_*` and `window.webkit.messageHandlers.*`
(doc 20 §e) — the preload defines **exactly those names** in the main world.
Config values (daemon URL, token) reach the preload synchronously via
`webPreferences.additionalArguments` (`--eos-daemon-url=…`, `--eos-ui-token=…`)
so they exist at document-start like the Swift `WKUserScript`s did (doc 10 §a).

Injected at document-start (before app JS):

| # | Name | Mechanism | Maps to |
|---|---|---|---|
| 1 | `window.__EOS_DAEMON_URL` | `exposeInMainWorld` string from argv | doc 10 §a script 1; doc 20 §e-1 |
| 2 | `window.__EOS_UI_TOKEN` | `exposeInMainWorld` string from argv | doc 10 §a script 5; doc 20 §e-2 |
| 3 | `document.documentElement.classList.add("native")` | direct DOM call from preload (DOM is shared across worlds; guard for pre-documentElement timing) | doc 10 §a script 2; doc 20 §e-3 |
| 4 | Context-menu suppression | **not** injected JS — one main-side `webContents.on("context-menu", e => e.preventDefault())` covers main frame **and** the `:7401` subframes (replaces both Swift suppressor scripts) | doc 10 §a scripts 2–3, §f9 |
| 5 | `window.webkit.messageHandlers` shim | `exposeInMainWorld("webkit", { messageHandlers: {...} })` — six entries below | doc 10 §d inbound |

The six `messageHandlers` entries (inbound web→main):

| Handler | Preload → main | Main behavior (parity) |
|---|---|---|
| `titlebarDrag.postMessage` | no-op | Not needed — drag is real CSS in Electron (§D4). Kept as a no-op so the injected-script contract shape survives; the Swift shell injected this JS itself, the UI never calls it (doc 20 §a). |
| `titlebarDblClick.postMessage` | no-op (same reason) | §D4 covers double-click. |
| `themeChanged.postMessage(t)` | `ipcRenderer.send` | Persist theme (userData JSON, replacing `UserDefaults EosTheme`), `win.setBackgroundColor(themeBackground(t))` (doc 10 §d-3). |
| `themeSnapshot.postMessage(null)` | `ipcRenderer.send` | `webContents.capturePage()` → JPEG data URL → `executeJavaScript("window.__eosThemeSnapshot('…')")`, `null` on failure (doc 10 §d-4; `capturePage` replaces `takeSnapshot`, and composites `backdrop-filter` correctly — doc 10 §f6). |
| `saveFile.postMessage({filename, base64, mimeType})` | `ipcRenderer.send` | Decode, write to `~/Downloads`, `shell.openPath` — **silent, no dialog**, exact parity (doc 10 §d-5, §e "must preserve the current no-dialog behaviour"). **CONFLICT** with doc 30 Claim 5.4 (`dialog`): actual app wins; a save dialog is a post-parity option only. Chromium's working `<a download>` fallback (doc 20 §c) makes this shim droppable later — flagged in §E. |
| `pasteboardPaths.postMessage(null)` → Promise | `ipcRenderer.invoke` | Main reads macOS pasteboard file URLs (`clipboard.read`/`readBuffer` of the file-URL type), `fs.stat` each → `[{path, isDir}]` (doc 10 §d-6). Implementation detail to verify at M3 — not covered by doc 30; if the Electron clipboard type dance proves unreliable, fall back to a 20-line native addon. |

Preload additionally owns **Finder drag/drop interception** (replacing the
`EosWebView` AppKit interception, doc 10 §d outbound rows 1–4): capture-phase
`dragenter`/`dragleave`/`drop` listeners on `document`; for drags carrying files,
`preventDefault`+`stopPropagation` (mirroring the Swift shell swallowing them
before the DOM), resolve real paths via `webUtils.getPathForFile(file)`
(`File.path` no longer exists in modern Electron), send to main; main stats
`isDir` and drives `__eosDragState(bool)` / `__eosNativeDrop(entries)` via
`executeJavaScript`. The UI sees byte-identical behavior (doc 20 §e-11).

### C5. Outbound driver (main → renderer)

All 18 Swift `evaluateJavaScript` sites become
`webContents.executeJavaScript(...)` calls — this is the **only** correct
mechanism because the UI defines its callback globals (`__eosThemeSnapshot`,
`__eosNativeDrop`, `__eosDragState`, `__nativeNavigate`, `__eosUndo`,
`__eosRedo`, `__eosTerm.*`) in the **main world**, which an isolated-world
preload cannot see; `executeJavaScript` runs in the main world. Full mapping in
§E. JSON payloads are serialized with the same shapes the UI already parses
(doc 10 §d table).

### C6. Startup sequence (deferred, per doc 30 Claim 3.4)

1. `registerSchemesAsPrivileged` → `app.whenReady()`.
2. `app.requestSingleInstanceLock()` — **needed for parity**: LaunchServices makes
   the Swift app single-instance implicitly; Electron is not (doc 30 Claim 5.6).
   Second instance → focus the existing window.
3. Daemon probe/spawn/health (§C3) — splash+update path if applicable (§D8).
4. Read token → create the main window **hidden**, with the theme background
   already set (§D5) → load `eos://app/index.html` → `show()` on
   `ready-to-show`.
5. **After** first paint: create Tray, start the main-process SSE consumer
   (notifications + tray state), install the app menu. None of these block
   time-to-first-frame.
6. `window-all-closed`: do **not** quit (macOS semantics, doc 10 §e); `activate`
   → re-show. The window's `close` event is intercepted → `win.hide()` instead of
   destroy, matching `isReleasedWhenClosed=false` — the web app (scroll state,
   stores) survives close/reopen exactly as in the Swift shell (doc 10 §b).
7. `before-quit`: `preventDefault`, POST `/workers/archived/app-closed` with a
   2 s-bounded fetch, then `app.exit()` (doc 10 §e `applicationWillTerminate`).

---

## D. Pixel-perfect design fidelity strategy

The reference design: a dark macOS window, native traffic lights top-left, web UI
full-bleed under a transparent titlebar, all "glass" painted by web CSS
(doc 10 preamble). **CONFLICT — the headline one:** doc 30 §1 recommends
`vibrancy` + `visualEffectState:'active'` for the main window. The actual app uses
**no NSVisualEffectView on the main window at all** (doc 10 §e vibrancy note);
adding vibrancy would (a) change the look, (b) stay lit when native would dim
(doc 30 Diff A), and (c) fight the UI's `backdrop-filter` glass (doc 30 Diff B).
**Actual app wins: no `vibrancy`, no `transparent:true`, opaque window.** This
conveniently sidesteps doc 30's three vibrancy diffs and GAP 1/2 for the main
window entirely.

### D1. BrowserWindow configuration

```js
new BrowserWindow({
  width: 1280, height: 820,            // doc 10 §b default content rect
  minWidth: 800, minHeight: 500,       // doc 10 §b minSize
  show: false,                          // reveal on ready-to-show (no flash)
  backgroundColor: themeBackground(initialTheme()), // "#1a1a1a" | "#f6f1e6" — §D5
  titleBarStyle: "hiddenInset",        // doc 30 Claims 1.1/1.2
  trafficLightPosition: { x: TL_X, y: TL_Y }, // measured — §D2
  title: "Eos",                         // doc 10 §b (title set, visibility hidden)
  roundedCorners: true,                 // radius parity — §D3
  webPreferences: {
    preload: PRELOAD_ABS_PATH,
    contextIsolation: true, sandbox: true, nodeIntegration: false,
    backgroundThrottling: false,        // doc 30 Claim 3.1 — live SSE window
    additionalArguments: [`--eos-daemon-url=${daemon}`, `--eos-ui-token=${token}`],
  },
});
```

Not used, deliberately: `frame:false` (traffic lights must stay native — doc 30
Claim 1.4 marks it more aggressive than needed), `transparent:true` (no native
shadow, resize breakage — doc 30 Claim 1.5), `vibrancy`/`visualEffectState`
(above), `backgroundMaterial` (Windows-only — doc 30 Claim 1.9).

### D2. Titlebar height + traffic-light position

The Swift shell gets its tall titlebar from an **empty unified NSToolbar**
(purely a sizing trick) and then nudges each traffic-light button **+3 pt up**,
targeting "13 px from the sidebar island's corner … the 6 px `--shell-gap` inset"
(doc 10 §b). Electron has no unified-toolbar equivalent (doc 10 §b states this
outright), but it doesn't need one: the web CSS already reserves and paints the
titlebar strip via `html.native` rules (doc 20 §a) — the only native-drawn pixels
are the three buttons. So parity reduces to **one (x, y) pair**:

1. Measure the button-center coordinates in the running Swift app (screenshot +
   pixel ruler at 2× scale).
2. Set `trafficLightPosition` to reproduce them (doc 30 Claim 1.3 — pixel control
   is exactly what this option is for). `hiddenInset` alone applies a fixed inset
   (doc 30 Claim 1.2) that will NOT match the toolbar-tall+3pt geometry — the
   explicit position is required, not optional.
3. Verify across: normal, resized (Swift re-applies on `windowDidResize`; Electron
   keeps the position across resizes per doc 10 §b's note — confirm), and
   fullscreen transitions (Swift suspends the positioner in fullscreen; check
   Electron's reveal-strip renders the buttons at the default spot — gate item).

### D3. Window corner radius (~10 pt) — highest chrome risk

Swift forces 10 pt by swizzling private `NSThemeFrame` methods before first
paint, because macOS Tahoe draws ~26 pt corners for **toolbar** windows and no
public API reduces it (doc 10 §b). The Electron window attaches **no toolbar**,
so Chromium's default radius may already be the standard small radius — possibly
close to 10 pt, possibly not; **no doc in 10/20/30 states Electron's macOS radius**
(open question §I-Q2). Plan:

- **M2 spike, day one:** screenshot both windows' corners at 2×, edge-detect,
  measure the radius delta.
- If within ±1 pt → accept, document the measured value.
- If off → options in order: (a) a ~30-line native addon (objc runtime) doing the
  same `NSThemeFrame` override the Swift app does — the technique is proven in
  this exact app; (b) accept the delta with sign-off. Rebuilding the frame in CSS
  via `transparent:true` is **rejected** (shadow/resize caveats, doc 30 Claim 1.5).

### D4. Drag regions + titlebar double-click

WKWebView ignores `-webkit-app-region`, so today drag is injected JS reading the
`--app-region` **custom property** on mousedown → `performDrag` (doc 10 §b).
Electron honors `-webkit-app-region: drag` natively — but **only the literal
property** (doc 20 §a), and Electron has **no programmatic window-drag API**, so
the JS-bridge path cannot be ported. Therefore:

- **The one UI change (constraint-3 exception):** in `app/ui/src/styles.css` (and
  the two component files), add the literal `-webkit-app-region: drag|no-drag`
  declaration next to each existing `--app-region` declaration (~9 sites:
  `styles.css:233,243,251,257,498,518,1235,1239,1421` per doc 20 §a).
  **Justification:** additive, one line per site; WKWebView ignores the literal
  property, so the Swift app is bit-identical during the transition; without it
  the Electron window cannot be dragged at all. The `--app-region` custom
  property stays for the Swift shell until cutover.
- **Double-click:** Swift reads the system `AppleActionOnDoubleClick` default and
  zooms/miniaturizes accordingly (doc 10 §b). Verify Electron's built-in
  double-click handling on drag regions honors that pref (M2 gate); if it
  doesn't, read the pref via
  `systemPreferences.getUserDefault("AppleActionOnDoubleClick","string")` and
  drive `win.maximize()/minimize()` from a renderer dblclick forwarded over IPC —
  same observable behavior.
- The Swift NSEvent mouse-down cache and the injected titlebar-drag script are
  both obsolete (doc 10 §f5, §f11); the shim handlers stay as no-ops (§C4).

### D5. Opaque pre-paint + theme switching

- Resolve the initial theme the way Swift does — persisted value else dark
  (doc 10 §a `initialTheme()`) — from the Electron-side persisted theme
  (userData JSON seeded by `themeChanged` events; §C4). Set
  `backgroundColor` at construction: **`#1a1a1a` dark / `#f6f1e6` light**
  (doc 10 §a `themeBackground`), plus `show:false`+`ready-to-show`. Result: no
  white/wrong-color flash, matching the Swift "paint before first paint" intent.
  The `index.html` inline bootstrap then paints the same colors from
  `localStorage["cm:theme"]` (doc 20 §d) — unchanged.
- On `themeChanged`: persist + `win.setBackgroundColor(...)` (doc 10 §d-3).
  Swift deliberately never sets `window.appearance` to avoid freezing
  `prefers-color-scheme` (doc 10 §d-3 note) — Electron analog: do **not** touch
  `nativeTheme.themeSource`; leave it `system` so the renderer's media query
  keeps tracking macOS.

### D6. Theme-snapshot crossfade

`themeSnapshot` → `capturePage()` → JPEG data URL → `__eosThemeSnapshot(url)`,
`null` on failure so `theme.js` bails to an instant apply (doc 10 §d-4; the UI's
fallback chain is `themeSnapshot` → `startViewTransition` → instant, doc 20 §e-7).
Electron bonus: `capturePage` composites `backdrop-filter` into the pixels
(doc 10 §f6), so the frozen frame is *more* correct than WKWebView's — the UI's
live re-blur workaround (`theme.js:70-72`) simply becomes redundant; leave it,
it's harmless over an already-correct frame.

### D7. Fullscreen

`enter-full-screen` / `leave-full-screen` → `executeJavaScript` toggling the
`fullscreen` class on `documentElement`, exactly the two Swift sites
(doc 10 §d outbound rows 5–6). Traffic-light behavior in the fullscreen reveal
strip is an M2 verification item (§D2).

### D8. Splash + auto-update window

The one place native vibrancy is allowed (constraint 1). Swift: macOS 26 uses
`NSGlassEffectView(cornerRadius:30, tint white-0.10)`, older uses a masked
`NSVisualEffectView(material:.popover, behindWindow, active)` (doc 10 §e/§vibrancy
note). Electron:

- Small frameless `BrowserWindow` with `vibrancy:"popover"` +
  `visualEffectState:"active"` (doc 30 Claims 1.6–1.8) approximating the
  **pre-26 fallback** look. There is **no Electron equivalent of macOS 26
  "Liquid Glass"** (nothing in doc 30; open question §I-Q3) — ship the fallback
  look on all macOS versions, A/B it, and accept the delta on 26+ (it shows for
  seconds during updates only).
- Flow parity (doc 10 §e): daemon healthy → `GET /api/updates/status` → if
  available, show splash → `POST /api/updates/apply` → poll `/health`
  `sourceStamp` until the rebuilt daemon returns → reload the main window in
  place, or if the shell binary itself changed, relaunch — Electron replaces the
  Swift detached `sh -c 'sleep 0.6; open …'` trick with the built-in
  `app.relaunch(); app.exit()`. **CONFLICT** with doc 30 §6's `electron-updater`
  framing: the live update mechanism is **daemon-driven source rebuild**, not
  Squirrel feeds; actual app wins — electron-updater is future distribution
  machinery only (§G).

### D9. A/B screenshot verification method (the parity gate)

No source guarantees visual parity (doc 30 GAP 2, and its consolidated-gaps note:
"pixel-perfect … empirically-verified-by-screenshot, not doc-guaranteed"). So
parity is *measured*:

1. **Fixture:** both apps pointed at the same daemon (same live data), one at a
   time per capture round; force identical window bounds (1280×820 via
   `setContentSize`/AppleScript), same display, same scale factor (capture at 2×).
2. **Capture:** `screencapture -o -l <windowId>` (window-scoped, `-o` drops the
   shadow) for: every main view, both themes, active + inactive window, normal +
   fullscreen, plus close-crops of the four corners and the traffic-light region.
3. **Compare:** pixel-diff (ImageMagick `compare -metric AE` or pixelmatch) with
   region masks and per-region budgets:
   - **Chrome geometry — strict:** traffic-light button centers within ±1 px @2×;
     corner-radius edge profile within ±1 px; background color **exact**
     (verified separately with Digital Color Meter on the base `#1a1a1a`).
   - **Web content — thresholded:** WebKit and Chromium rasterize glyphs and
     antialias differently, so the interior will never be bit-identical
     (§I-R13). Budget: per-pixel color delta tolerance + a small changed-pixel
     percentage, tuned on the first run; layout must be identical (diff clusters
     along glyph edges are acceptable, shifted boxes are not).
   - **Overlay flip test (human):** alternate the two captures at 50% opacity;
     any perceptible "jump" in chrome, spacing, or color fails the gate.
4. **Automated where possible:** a small script drives capture + diff and emits a
   per-region pass/fail table — this is the M2 and M7 gate artifact.

---

## E. Feature-parity matrix

Every native capability and bridge message from docs 10/20 → its Electron
mechanism. "Obsolete?" = Electron natively removes the need (doc 10 §f), but the
shim is still provided wherever the UI calls it (constraint 3).

### E1. Inbound bridge (web → shell), doc 10 §d 1–6

| Message | Today (Swift) | Electron mechanism | Obsolete? |
|---|---|---|---|
| `titlebarDrag` | injected JS → `performDrag` | real `-webkit-app-region: drag` CSS (§D4); shim = no-op | **Yes** (doc 10 §f5) |
| `titlebarDblClick` | injected JS → zoom/minimize per `AppleActionOnDoubleClick` | Electron built-in on drag region; else `systemPreferences.getUserDefault` + IPC (§D4) | Mostly |
| `themeChanged` | persist `EosTheme`, repaint window/webview bg | IPC → persist userData JSON + `setBackgroundColor` | No |
| `themeSnapshot` | `takeSnapshot` → `__eosThemeSnapshot(jpegDataURL)` | IPC → `capturePage()` → `executeJavaScript` | No (but better: composites backdrop-filter, doc 10 §f6) |
| `saveFile` | silent write `~/Downloads` + open | IPC → `fs.writeFile` + `shell.openPath`, identical UX | **Could be** — `<a download>` works in Chromium and the UI already falls back (doc 20 §c); keep shim for exact parity |
| `pasteboardPaths` (reply) | `NSPasteboard` → `[{path,isDir}]` | `ipcRenderer.invoke` → main reads clipboard file-URLs + `fs.stat` | **Could be** — Chromium DnD/clipboard expose paths (doc 10 §f1); keep shim, UI calls it on ⌘V |

### E2. Outbound globals (shell → web), doc 10 §d table (18 sites)

| Global | Today (Swift sites) | Electron driver |
|---|---|---|
| `__eosDragState(bool)` | drag enter/exit/end (3 sites) | preload capture-phase drag listeners → main → `executeJavaScript` (§C4) |
| `__eosNativeDrop(entries)` | Finder drop (1) | same pipeline, paths via `webUtils.getPathForFile` + main-side `isDir` stat |
| `fullscreen` class add/remove | fullscreen hooks (2) | `enter/leave-full-screen` → `executeJavaScript` (§D7) |
| `__nativeNavigate(id)` | notification tap + AgentNavigator (2) | Notification `click` / tray navigator → focus + `executeJavaScript` |
| `__eosUndo()` / `__eosRedo()` | Edit menu ⌘Z/⌘⇧Z (2) | menu accelerator (NOT `role:'undo'`) → `executeJavaScript` — roles would fire Chromium's native contentEditable undo and bypass the composer's own stack; parity = Swift's unconditional routing (doc 10 §d) |
| `__eosTerm.getSelectionIfFocused/isFocused/pasteBase64/selectAll` | Edit menu ⌘C/⌘X/⌘V/⌘A (7 sites) | menu accelerators → `executeJavaScript` replicating `main.swift:998-1041` exactly: terminal-focused → term op via `clipboard.readText/writeText`; else `webContents.copy()/cut()/paste()/selectAll()`. Post-parity simplification to plain roles is possible (Chromium clipboard is unrestricted, doc 10 §f2) but changes ordering semantics — defer |
| `__eosThemeSnapshot(url\|null)` | snapshot reply (2) | §D6 |

### E3. OS integrations, doc 10 §e

| Capability | Today (Swift) | Electron mechanism | Notes |
|---|---|---|---|
| Menu-bar status item | custom `BarStatusView`: breathing dawn-star + count, completion pill + draining underline + `+N`, light/dark palette, Reduce Motion | `Tray` (doc 30 Claim 5.1) + **frame-pushed `nativeImage`s** rendered on a canvas in a hidden offscreen renderer; timer-driven `tray.setImage` during animations; static template image when idle/reduced-motion | Trays can't host live views — hardest parity item (doc 10 §e). Left-click → show window, right-click → `popUpContextMenu` (do NOT `setContextMenu`, it would steal left-click). |
| Fleet state feed for tray | own SSE `/stream` + 4 s `/workers` poll, `FleetReducer`, `CompletionQueue` | port reducer/queue logic to the main process on the shared SSE consumer + poll | Pure logic, ports 1:1. |
| Notifications | `UNUserNotification` from shell-owned SSE, only when app **not active**, tap → navigate | main-process SSE consumer (Node fetch-stream or `eventsource` pkg) filtering `reason=="notification:fire"`; gate on window/app focus state; `new Notification` (doc 30 Claim 5.2); `click` → `app.focus` + show + `__nativeNavigate` | Web `Notification` API unused by UI (doc 20 §c) — this stays main-side. |
| App menu accelerators | About/⌘Q, Edit ⌘Z/⌘⇧Z/⌘X/⌘C/⌘V/⌘A, View ⌘R, Window ⌘M/Zoom — **no global shortcuts** | `Menu.setApplicationMenu` with same items; ⌘R = `session.clearCache()` (HTTP only — preserves localStorage, doc 10 §a) + reload | **CONFLICT** ×2 with doc 30: Claim 5.3 (`globalShortcut`) — app has none, add none; Claim 3.10 (`setApplicationMenu(null)`) — the menu IS the clipboard/undo bridge, keep it. Actual app wins. |
| Dock / lifecycle | Dock-visible, no quit on last-window-close, reopen → show | no `app.dock.hide()`; ignore `window-all-closed`; `activate` → show; close → hide (§C6) | doc 10 §e/§b. |
| Save dialogs / pickers | none — silent Downloads write; pickers via daemon `osascript` | keep both unchanged | **CONFLICT** with doc 30 Claim 5.4; actual app wins. Electron `dialog` = optional post-parity UX upgrade (doc 20 §c marks it optional). |
| Secret storage | plaintext `~/.eos/ui-token` | read same file | **CONFLICT** with doc 30 Claim 5.5 (`safeStorage`); actual app wins (doc 10 §e: "do not introduce safeStorage unless intended"). |
| Deep links | none (`eos://` is internal-only; no `CFBundleURLTypes`) | register nothing | **CONFLICT** with doc 30 Claim 5.7; actual app wins. |
| External links | `NSWorkspace.open` for non-eos/non-loopback | `setWindowOpenHandler` deny+`shell.openExternal`; `will-navigate` → same filter, block SPA-origin frame navigation | doc 10 §e, doc 20 §e-13. UI has no `window.open`/`_blank` (doc 20 §c) — purely shell-side. |
| Launch-at-login / AppleScript | none | none | doc 10 §e. |
| Single instance | implicit (LaunchServices) | `app.requestSingleInstanceLock()` (doc 30 Claim 5.6) | Electron needs it explicitly — parity addition. |
| Daemon spawn | bash `ulimit` wrapper + log redirect + health poll | identical wrapper from Node `child_process` (§C3) | fd-limit bump non-negotiable (doc 10 §f12). |
| Auto-update | splash + `/api/updates/*` + `sourceStamp` poll + relaunch | same flow; `app.relaunch()` (§D8) | daemon-driven, not Squirrel. |
| Quit hook | POST `app-closed`, 2 s bound | `before-quit` bounded fetch (§C6) | doc 10 §e. |
| Window-frame persistence | `setFrameAutosaveName("Eos")` | manual debounced bounds save/restore in userData | doc 10 §b: Electron must do this manually. |
| Key-beep suppression | `QuietWindow` subclass | nothing — Chromium doesn't beep; verify at M2 | Obsolete (doc 10 §f10). |
| DevTools | `developerExtrasEnabled` + `isInspectable` | default devTools; keep enabled | Obsolete friction (doc 10 §f7). |
| Context-menu suppression | 2 injected scripts (main + 7401 frames) | one `context-menu` handler | Obsolete as injected JS (doc 10 §f9). |

### E4. Injected environment, docs 10 §a / 20 §a

| Item | Electron mechanism |
|---|---|
| `__EOS_DAEMON_URL` | preload from argv (§C4). Port from `~/.eos/config.json` if overridden, default 7400 (doc 20 §e-1; note the UI hardcodes the `+1 → 7401` raw-origin mapping, doc 20 §b — unchanged). |
| `__EOS_UI_TOKEN` | preload from argv, read post-health (§C3). |
| `html.native` class | preload DOM call (§C4). |
| `eos://app/` origin + localStorage | same scheme name kept (§C2). Storage backend is a fresh Chromium profile → **one-time reset of ephemeral localStorage prefs** (active view, scroll, theme bootstrap); durable settings unaffected — they live daemon-side (doc 20 §c localStorage row). Accepted, see §I-R12. |
| Cache clear on reload preserving localStorage | `session.clearCache()` (HTTP cache only) — exact analog of Swift's selective clear (doc 10 §a). |

Nothing else to provide: no `getUserMedia`/media permissions, no web
`Notification`, no UA sniffing, no UDS from the browser (doc 20 §e "not needed").

---

## F. Performance & security configuration

Performance (constraint 2; doc 30 §3):

- `backgroundThrottling: false` on the main window — the SSE dashboard must keep
  drawing when backgrounded (doc 30 Claims 3.1/3.2).
- Single bundled main + single bundled preload (esbuild), `require()` cost paid
  once (doc 30 Claim 3.6).
- Deferred startup: window first, Tray/SSE/menu after first paint (§C6; doc 30
  Claim 3.4); nothing long-running on the main thread — SSE parsing is stream
  callbacks, update polling is timers (doc 30 Claim 3.5).
- One renderer total (doc 30 Claim 3.8); no extra windows except the transient
  splash.
- `codeCache: true` on the scheme privileges (doc 30 Claim 2.3) for V8 code
  caching of the SPA bundles.
- V8 startup snapshots via Fuses/mksnapshot: **post-parity optimization only**
  (magnitude is secondary-sourced, doc 30 Claim 3.7 / GAP 6).
- Memory honesty: Chromium baseline ~150–300 MB idle vs WKWebView's far lower
  footprint (doc 30 §3 memory note, secondary) — an accepted cost of the move;
  measured at M7, not "fixed".
- NOT doing: `Menu.setApplicationMenu(null)` (menu is load-bearing — §E3
  conflict), `--disable-http-cache` (the scheme handler + `session.clearCache`
  manage caching; the daemon API is uncached fetch anyway).

Security (doc 30 §4):

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` — all
  defaults kept (doc 30 Claims 4.1–4.4).
- Preload exposes only the §C4 surface via `contextBridge` — never raw
  `ipcRenderer` (doc 30 Claim 4.5).
- CSP header on the `index.html` response from `protocol.handle` (§C2; doc 30
  Claim 2.5): `default-src 'self' eos:; connect-src eos: http://127.0.0.1:*
  ws://127.0.0.1:*; img-src eos: data: blob: http://127.0.0.1:*; frame-src
  http://127.0.0.1:7401 …` — exact policy finalized at M1 against real traffic
  (the UI fetches loopback HTTP/SSE/WS and embeds 7401 iframes, doc 20 §b).
- Loopback-HTTP daemon access is a stated **design choice**, not a doc guarantee
  (doc 30 GAP 7): same trust model as today — loopback + per-boot
  `x-eos-ui-token` (doc 20 §b), unchanged.
- Navigation lockdown: `will-navigate` allowlist (`eos://app/*` only) +
  `setWindowOpenHandler` deny-and-open-external (§E3).
- `webSecurity` stays default-on; the daemon already serves this cross-origin
  pattern (doc 20 §d) — M1 gate verifies the `Origin: eos://app` header passes
  daemon CORS unchanged.

---

## G. Packaging, signing, notarization, updates

Toolchain: **Electron Forge** — Electron's own packaging tutorial directs to it
and it composes first-party modules (doc 30 Claims 6.2–6.4; "official
recommendation" wording is GAP 10 — framed as directed-to, not endorsed).
electron-builder remains the fallback if installer/publish-matrix needs grow
(doc 30 Claim 6.1).

- **Universal binary** (arm64+x64) via `@electron/universal` under Forge
  (doc 30 Claim 6.5).
- **Code signing:** Developer ID certificate — exact cert-name wording is
  doc 30 GAP 8; confirm "Developer ID Application" against electron.build's
  signing doc during M6. Unsigned apps won't run (doc 30 Claim 6.6).
- **Hardened Runtime** + entitlement `com.apple.security.cs.allow-jit` (V8
  JIT, doc 30 Claim 6.8). Do **NOT** add
  `allow-unsigned-executable-memory` — Electron ≥12 doesn't need it and it widens
  attack surface (doc 30 §6 secondary note; we're on 42).
- **Notarization** with `notarytool` (`altool` deprecated) — hard requirement for
  outside-App-Store distribution (doc 30 Claims 6.7/6.9).
- **Footprint expectation:** ~80–100 MB zipped / >100 MB installed (doc 30
  Claim 6.11) vs the current thin Swift wrapper — accepted cost, stated up front.
- **Auto-update — two distinct layers, don't conflate:**
  1. *Content/daemon updates* (what "update" means in Eos today): the
     daemon-driven `/api/updates/*` flow with the splash (§D8). This ships at M5
     and is the parity requirement.
  2. *Shell binary updates*: today `app/build.sh` rebuilds `/Applications/Eos.app`
     locally and the update flow relaunches when the binary changed (doc 10 §e) —
     there is no Squirrel/appcast today. `electron-updater` (Squirrel.Mac,
     requires signed app — doc 30 Claim 6.10, slug caveat GAP 9) becomes relevant
     only if/when the Electron shell is distributed as a downloaded artifact
     rather than locally built. Plan: wire the *hook* (update-feed config behind a
     flag) at M6 but keep the local-build path primary until distribution
     changes.
- **Coexistence with `app/build.sh` during transition:** `app-electron/` gets its
  own `build.sh`/Forge scripts producing `out/Eos.app` (or a distinctly named
  bundle, e.g. `Eos Electron.app`, until cutover) — it never touches
  `/Applications/Eos.app`, which the Swift `app/build.sh` keeps owning. Both
  shells consume the **same** `app/ui/dist` (the Vite `base:"./"` build is
  scheme-agnostic, doc 20 §d), so a UI build feeds both. At cutover (post-M7
  sign-off) the Forge output takes the `/Applications/Eos.app` name and
  `app/build.sh` is retired.

---

## H. Phased migration roadmap

**Location:** new **`app-electron/`** beside `app/` — its own package dir per the
monorepo convention (not a workspace; install per dir), sitting at the
entrypoints layer of the dependency direction. It imports nothing from other
packages at runtime (the handful of route paths it needs — `/health`, `/stream`,
`/api/updates/*`, `/workers/archived/app-closed` — are string constants, same as
the Swift shell hardcodes them). `npm run bootstrap` gains the dir;
`eos build` gains a content-hash stamp for `app-electron/` exactly like the other
packages. The Swift `app/` is untouched until cutover.

Each milestone has a **gate** — a checkable exit condition. Do not start Mn+1
before Mn's gate passes.

- **M0 — Scaffold.** `app-electron/` with pinned Electron 42.10.1, Forge, esbuild
  bundling for main+preload, loading `../app/ui/dist` via a plain
  `protocol.handle` stub.
  *Gate:* `npm start` opens a window rendering the built UI; DevTools opens;
  `npm run lint` at repo root still passes with the new dir.
- **M1 — Scheme + daemon wiring.** Full §C2 scheme (privileges, containment,
  MIME, CSP), §C3 daemon spawn (ulimit wrapper, log, health poll, token read),
  §C4 preload globals, `backgroundThrottling:false`, external-link and
  navigation lockdown.
  *Gate:* UI fully functional against a live daemon with `sandbox`+
  `contextIsolation` on — SSE `/stream` events render live, browser-panel
  WebSocket connects, an authed mutation (needs `x-eos-ui-token`) succeeds;
  `window.isSecureContext === true` (GAP 5 check); daemon CORS accepts the
  origin with **zero daemon changes**; audit confirms no media loads from
  `eos://` (GAP 3 check).
- **M2 — Window chrome (pixel-perfect core).** §D1 config; the two spikes first:
  corner-radius measurement (§D3) and traffic-light offset tuning (§D2); drag
  regions (the §D4 CSS addition in `app/ui`), double-click behavior, opaque
  pre-paint + `themeChanged` repaint, hide-on-close, frame persistence,
  fullscreen class + reveal-strip check, no-beep check.
  *Gate:* §D9 A/B protocol on chrome regions passes (traffic lights ±1 px @2×,
  radius ±1 px or signed-off delta, background exact); manual checklist: drag
  from every `--app-region:drag` strip, double-click honors the system pref,
  fullscreen in/out toggles the class, close→reopen preserves web state.
- **M3 — Bridge parity.** All §E1 shims, §E2 drivers, DnD interception,
  Edit-menu clipboard/undo routing, theme-snapshot crossfade, `saveFile`,
  `pasteboardPaths`.
  *Gate:* scripted walkthrough of every §E1/§E2 row demonstrated working
  (checklist artifact); theme toggle crossfades without flash in both
  directions; Finder drag shows the drop UI and delivers real paths incl. a
  directory; ⌘C/⌘V in and out of the terminal match Swift behavior side-by-side.
- **M4 — Tray + notifications + lifecycle.** Main-process SSE consumer;
  Notification fire/click/navigate with the not-focused gate; Tray static
  icon+count, then pill/animations (ported FleetReducer/CompletionQueue logic);
  single-instance; quit hook; Dock/reopen semantics.
  *Gate:* e2e: worker completes → notification (only when app unfocused) →
  click → app focuses on the right worker; tray count tracks live agents;
  completion pill plays and drains side-by-side with the Swift app; second
  launch focuses the first instance; quitting posts `app-closed` (verified in
  daemon log).
- **M5 — Splash + update flow.** §D8 in full with `app.relaunch()`.
  *Gate:* staged update e2e on a test source bump: splash appears with the
  vibrancy look, apply → `sourceStamp` flips → reload-in-place path AND
  relaunch path both exercised.
- **M6 — Packaging.** Forge make: universal, signed, hardened runtime with
  `allow-jit` only, notarized via notarytool; `eos build` stamp integration;
  GAP 8/9 confirmations.
  *Gate:* notarization accepted; `spctl -a -vv` passes; the packaged app
  cold-launches on a clean machine (no dev toolchain) and reaches a healthy
  daemon; `app/build.sh` still produces the Swift app unaffected.
- **M7 — Parity audit + cutover decision.** Full §D9 suite (every view × theme ×
  focus state × fullscreen), perf snapshot (cold launch to first frame, idle CPU
  with live SSE, memory RSS vs Swift baseline), regression list.
  *Gate:* pixel-diff report within budgets, no open P1 regressions; explicit
  go/no-go to point `/Applications/Eos.app` at the Forge output and retire
  `app/build.sh`.

Estimated shape: M0–M1 are mechanical; M2 and M4 carry the risk (chrome
geometry, tray animation); M3 is broad but each row is small; M6 is
bureaucratic (certs/notarization latency).

---

## I. Risks & open questions

### Doc 30's 10 GAPs, disposed

| GAP | Status in this plan | Resolution path |
|---|---|---|
| 1 — no vibrancy→NSVisualEffectView material mapping table | **Neutralized for the main window** (no vibrancy — actual app wins, §D). Residual: splash only | A/B the splash with `vibrancy:"popover"` at M5; the look shows for seconds |
| 2 — no quantified vibrancy blur/tint parity | Same as GAP 1 — splash-only | Same; accept small delta |
| 3 — Range/206 undocumented on `protocol.handle` | No media loads from `eos://` today (doc 10 §c) | M1 gate audits `dist/`; implement Range in the handler only if ever needed |
| 4 — SSE over custom scheme undocumented | **Avoided by design** — daemon SSE stays on direct loopback HTTP (§C2), per doc 30's own recommendation | None needed; M1 gate proves SSE live |
| 5 — `secure` scheme ⇒ secure context is doc-thin | Assert at runtime | M1 gate: `window.isSecureContext === true` |
| 6 — V8-snapshot magnitude secondary-only | Snapshots deferred to post-parity | Measure before adopting |
| 7 — loopback-HTTP-is-safe is inference, not doc | Stated as a design choice (§F) — identical trust model to today's shell | Accepted; token model unchanged |
| 8 — Developer ID cert name not verbatim-sourced | M6 confirmation item | Check electron.build code-signing-mac doc during M6 |
| 9 — electron-updater doc slug unconfirmed | electron-updater is future-facing only (§G) | Confirm slug if/when distribution changes |
| 10 — "Forge officially recommended" not literal | Framed as "tutorial directs to Forge" (§G) | None — wording only |

### Additional risks found in synthesis (R) and open questions (Q)

- **R1 — Corner radius (highest chrome risk).** Swift needs private
  `NSThemeFrame` swizzling for 10 pt (doc 10 §b); Electron's macOS radius is
  unmeasured and has no public API. *Resolve:* M2 day-one spike; native addon
  fallback; accept-with-sign-off as last resort (§D3).
- **R2 — Traffic-light geometry.** No unified-toolbar analog; `hiddenInset`'s
  fixed inset won't match the toolbar-tall+3 pt spot without explicit
  `trafficLightPosition`; fullscreen reveal-strip behavior unverified
  (doc 10 §b). *Resolve:* measure-and-tune + M2 gate items (§D2).
- **R3 — No programmatic window drag in Electron.** Forces the one UI change
  (additive `-webkit-app-region`, §D4). *Resolve:* accepted, justified; risk low.
- **R4 — Double-click zoom pref.** Electron's honoring of
  `AppleActionOnDoubleClick` on drag regions is unverified. *Resolve:* M2 check;
  manual `systemPreferences.getUserDefault` fallback (§D4).
- **R5 — Tray animation parity.** Breathing star + pill + drain can't be a live
  view in a `Tray`; frame-pushed images cost CPU at animation time and must match
  the custom drawing, palettes, and Reduce Motion behavior (doc 10 §e).
  *Resolve:* port drawing to canvas offscreen; static-first at M4; cap frame
  rate; A/B side-by-side gate.
- **R6 — Edit-menu semantics.** Roles vs custom routing changes undo/clipboard
  ordering for the composer's own undo stack and xterm (doc 10 §d note).
  *Resolve:* replicate Swift routing exactly via accelerators +
  `executeJavaScript` (§E2); simplification deferred.
- **R7 — `webUtils.getPathForFile` in a sandboxed preload** and directory drops.
  Modern Electron removed `File.path`; the drag pipeline depends on `webUtils`
  working under `sandbox:true`, and folder drops must yield readable paths
  (doc 10 §f1 promises this; version-specific behavior unverified).
  *Resolve:* M3 spike with file, folder, and multi-item drags.
- **R8 — `pasteboardPaths` clipboard type dance.** Reading file URLs from the
  macOS pasteboard via Electron's `clipboard` API is undocumented territory
  (not in doc 30). *Resolve:* M3 spike; tiny native addon fallback (§C4).
- **R9 — Preload timing for `html.native`.** The class must exist before UI CSS
  evaluates; preload runs early but `documentElement` timing needs a guard
  (§C4). *Resolve:* M1 verification (no flash of non-native styling).
- **R10 — Daemon CORS with the Chromium-sent `Origin`.** Expected identical
  (`eos://app`) but the header serialization of custom schemes may differ from
  WKWebKit's (doc 20 §d told us to confirm daemon-side). *Resolve:* M1 gate;
  if it differs, a daemon allow-origin addition is a one-liner — but the goal is
  zero daemon changes.
- **R11 — Memory/footprint regression.** ~150–300 MB idle + >100 MB on disk vs
  the thin WKWebView wrapper (doc 30 §3/§6). *Resolve:* accepted cost of the
  WKWebView escape (doc 10 §f); measured at M7 so the number is known, not
  discovered.
- **R12 — One-time localStorage reset.** New browser profile ⇒ ephemeral prefs
  (active view, scroll positions, theme bootstrap key) reset once at cutover;
  durable settings are daemon-side and unaffected (doc 20 §c). *Resolve:* accept
  + release-note it; optionally pre-seed `cm:theme` from the shell-persisted
  theme via `executeJavaScript` on first run.
- **R13 — Cross-engine text rendering.** WebKit vs Chromium glyph
  rasterization/AA differ; interior pixels will never be bit-identical.
  *Resolve:* scope "pixel-perfect" to chrome/layout/color with the §D9 budgets;
  human overlay test for perceptibility.
- **R14 — Site-isolation processes for 7401 iframes.** Cross-origin iframes may
  spawn extra renderer processes (memory). *Resolve:* measure at M7; acceptable.
- **R15 — SSE consumer in the main process.** Node has no browser `EventSource`
  reconnect semantics; the Swift consumer has its own reader + poll
  (doc 10 §e, doc 20 §b). *Resolve:* small fetch-stream parser with the same
  backoff discipline as the UI's `sse.js`; shared by tray + notifications.

- **Q1 — Electron fullscreen reveal-strip traffic-light rendering** (Swift
  detaches the toolbar so only buttons show, doc 10 §b): not answered by any
  doc. M2 gate item.
- **Q2 — Chromium's actual macOS window corner radius on Tahoe** (toolbar-less):
  not in any doc. M2 spike (R1).
- **Q3 — macOS 26 "Liquid Glass" splash equivalent:** none known in Electron
  (absent from doc 30). Ship the pre-26 fallback look everywhere (§D8).
- **Q4 — `ready-to-show` vs the Swift "paint before first paint" guarantee:**
  Electron's `backgroundColor`+`show:false` is believed equivalent
  (doc 10 §a maps it so), but the no-flash property is empirical. M2 gate.

### Pre-existing follow-up (not caused by this migration)

- **Stale localStorage comment in `app/ui/src/api/client.js:594-595`** — the
  comment reads "localStorage is wiped on every Eos.app launch, so it can't hold
  durable settings", but the current shell deliberately **preserves**
  localStorage across launches — `loadWeb()` clears only HTTP caches
  (doc 10 §a, `main.swift:505-512`). The daemon-side settings design remains
  correct (and becomes *more* correct at cutover, since the origin's storage
  resets once — R12); only the comment's stated reason is stale. One-line
  comment fix, out of scope for this plan's no-source-changes rule — land it
  with the §D4 CSS change at M2.
