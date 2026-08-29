# Electron Migration Research — WKWebView → Electron with Pixel-Perfect macOS Chrome

Research question: how to port a dark, native-macOS WKWebView-hosted React/Vite
app (custom `eos://app/` scheme, local daemon over HTTP+SSE) to Electron while
preserving the EXACT current look, with strong performance and correct packaging.

Access date for every quote below: **2026-08-29**.
Evidence rule: each factual claim carries a verbatim quote + source URL + tier
(primary = official docs/product; secondary = blog/issue/news). Single-source or
secondary-only claims are marked **[thin]**. Gaps are named, not padded.

---

## Version pin (current stable as of 2026-08-29)

Latest stable Electron is **42.10.1**, released **August 25, 2026**, bundling
**Chromium 148.0.7778.280** and **Node.js 24.18.1**.

> "Electron: 42.10.1 ... Chromium: 148.0.7778.280 ... Node.js: 24.18.1"
> — https://releases.electronjs.org/releases/stable (primary)

Cadence context (why the major moves ~every 8 weeks, so pin explicitly in
`package.json` and expect a Chromium bump each major):

> "Electron targets Chromium even-number versions, releasing every 8 weeks in
> concert with Chromium's 4-week release schedule."
> — https://www.electronjs.org/docs/latest/tutorial/electron-timelines (primary)

Note: an earlier search surfaced Electron 40 (Chromium 144 / Node 24.11.1, Jan
2026) and 41 (Chromium 146). 42.10.1 supersedes both and is the version to target.

---

## Executive summary — headline recommendation per section

1. **Pixel-perfect macOS chrome** — Use `titleBarStyle: 'hiddenInset'` (traffic
   lights kept, inset to match the current hidden-inset look) + `vibrancy`
   (`'sidebar'` / `'under-window'` / `'fullscreen-ui'` — pick to match the
   current NSVisualEffectView material) + `visualEffectState: 'active'` to force
   the dark material to stay lit like the Swift build likely does. Do **not** use
   `transparent: true` (loses native shadow, breaks resize) and do **not** use
   `backgroundMaterial` (Windows-only). Known divergences to accept/manage: native
   apps dim vibrancy when inactive whereas Electron forces it active; CSS
   `backdrop-filter: blur()` conflicts with native vibrancy; resize can flicker.

2. **Custom protocol** — Replace `eos://` with `protocol.handle(scheme, handler)`
   returning a `Response`, and declare the scheme in
   `protocol.registerSchemesAsPrivileged` (before `app.ready`) as
   `{ standard, secure, supportFetchAPI, stream }`. `stream: true` supports
   streaming bodies; Range/`206` and SSE over the custom scheme are **not**
   documented and must be hand-implemented / validated — treat as risk.

3. **Performance** — Set `webPreferences.backgroundThrottling: false` on the main
   window so live SSE keeps drawing when backgrounded. Bundle main-process code to
   one file, defer expensive startup work, never block the main/UI thread, and
   `Menu.setApplicationMenu(null)` if unused. V8 snapshots are a real startup win
   but wired via Fuses/mksnapshot, not a one-line flag. Accept a higher memory
   baseline than WKWebView (~150–300MB idle) because Chromium is bundled.

4. **Security baseline** — Keep the secure defaults: `contextIsolation: true`,
   `sandbox: true`, `nodeIntegration: false`. Do all privileged work in the main
   process, expose a narrow API via a preload `contextBridge.exposeInMainWorld`,
   and set a CSP. The local daemon is reached from the main process (or via
   fetch from a `secure`-privileged renderer), keeping renderers sandboxed.

5. **Native equivalents** — Swift StatusItem → `Tray`; notifications →
   `Notification`; hotkeys → `globalShortcut`; file pickers → `dialog`; keychain →
   `safeStorage` (macOS Keychain-backed); single instance →
   `app.requestSingleInstanceLock()`; deep links → `app.setAsDefaultProtocolClient`
   + the `open-url` event + `CFBundleURLTypes`; dock → `app.dock`.

6. **Packaging** — Recommend **Electron Forge** (Electron's own packaging tutorial
   directs you to it and it uses first-party modules), unless you already need
   electron-builder's richer installer/auto-update matrix. Ship a **universal**
   (arm64+x64) build, **code sign** with Developer ID, enable **Hardened Runtime**
   with the `allow-jit` entitlement, **notarize** with `notarytool`, and use
   `electron-updater` (Squirrel.Mac; requires a signed app). Expect an ~80–100MB
   zipped / >100MB installed footprint.

---

## Section 1 — Pixel-perfect macOS chrome

Recommendation: `titleBarStyle: 'hiddenInset'`, native traffic lights kept and
optionally repositioned via `trafficLightPosition`, `vibrancy` set to the material
that matches the current window, `visualEffectState: 'active'` to stop the
inactive-window dim. Avoid `transparent`/`frame:false` for the main content window;
avoid `backgroundMaterial` on macOS.

Claim 1.1 — `titleBarStyle: 'hidden'` hides the bar but keeps traffic lights.
> "`hidden` - Results in a hidden title bar and a full size content window. On
> macOS, the window still has the standard window controls (\"traffic lights\") in
> the top left."
> — https://www.electronjs.org/docs/latest/api/structures/base-window-options (primary)

Claim 1.2 — `'hiddenInset'` is the macOS variant with traffic lights inset further
(this is the look a hidden-inset titlebar app currently has).
> "`hiddenInset` _macOS_ - Results in a hidden title bar with an alternative look
> where the traffic light buttons are slightly more inset from the window edge."
> — https://www.electronjs.org/docs/latest/api/structures/base-window-options (primary)

> "Applying `hiddenInset` title bar style will shift the vertical inset of the
> traffic lights by a fixed amount."
> — https://www.electronjs.org/docs/latest/tutorial/custom-title-bar (primary)

Claim 1.3 — `trafficLightPosition` gives pixel control over traffic-light x/y (use
to match the current offset exactly).
> "Set a custom position for the traffic light buttons in frameless windows."
> — https://www.electronjs.org/docs/latest/api/structures/base-window-options (primary)

> "If you need more granular control over the positioning of the traffic lights,
> you can pass a set of coordinates to the `trafficLightPosition` option in the
> `BrowserWindow` constructor."
> — https://www.electronjs.org/docs/latest/tutorial/custom-title-bar (primary)

Claim 1.4 — `frame: false` = fully frameless (more aggressive than hiddenInset;
usually NOT needed if you keep traffic lights).
> "Specify `false` to create a frameless window. Default is `true`."
> — https://www.electronjs.org/docs/latest/api/structures/base-window-options (primary)

Claim 1.5 — `transparent: true` has real macOS caveats: no native shadow, and it
is documented as not resizable — a reason to prefer opaque window + vibrancy.
> "Makes the window transparent. Default is `false`."
> — https://www.electronjs.org/docs/latest/api/structures/base-window-options (primary)

> "The native window shadow will not be shown on a transparent window"
> — https://www.electronjs.org/docs/latest/tutorial/custom-window-styles (primary)

> "Transparent windows are not resizable. Setting resizable to true may make a
> transparent window stop working on some platforms"
> — https://www.electronjs.org/docs/latest/tutorial/custom-window-styles (primary)

Claim 1.6 — `vibrancy` is macOS-only and takes the full NSVisualEffectView
material set (choose the one matching the current window — `sidebar`,
`under-window`, `fullscreen-ui`, `hud`, etc.).
> "Add a type of vibrancy effect to the window, only on macOS. Can be
> `appearance-based`, `titlebar`, `selection`, `menu`, `popover`, `sidebar`,
> `header`, `sheet`, `window`, `hud`, `fullscreen-ui`, `tooltip`, `content`,
> `under-window`, or `under-page`."
> — https://www.electronjs.org/docs/latest/api/structures/base-window-options (primary)

Claim 1.7 — `setVibrancy()` is the runtime equivalent and the docs explicitly tie
the values to Apple's NSVisualEffectView (this is the AppKit-material mapping).
> "Adds a vibrancy effect to the window. Passing `null` or an empty string will
> remove the vibrancy effect on the window." ... "See the [macOS documentation]
> (https://developer.apple.com/documentation/appkit/nsvisualeffectview) for more
> details."
> — https://www.electronjs.org/docs/latest/api/base-window (primary)

Claim 1.8 — `visualEffectState` controls the active/inactive backdrop; set
`'active'` to keep the dark material always lit.
> "`followWindow` - The backdrop should automatically appear active when the
> window is active, and inactive when it is not. This is the default. `active` -
> The backdrop should always appear active. `inactive` - The backdrop should
> always appear inactive."
> — https://www.electronjs.org/docs/latest/api/structures/base-window-options (primary)

Claim 1.9 — `backgroundMaterial` is **Windows-only** (Mica/Acrylic), NOT a macOS
control — do not reach for it to get macOS vibrancy.
> "Set the window's system-drawn background material, including behind the
> non-client area. Can be `auto`, `none`, `mica`, `acrylic` or `tabbed`."
> — https://www.electronjs.org/docs/latest/api/structures/base-window-options (primary)

> "This method is only supported on Windows 11 22H2 and up."
> — https://www.electronjs.org/docs/latest/api/base-window (primary)

### Known visual diffs / limitations vs native AppKit (weight these — pixel-perfect is the constraint)

Diff A — **[thin, secondary]** Native macOS dims vibrancy when the window is
inactive; Electron forces it always-active. If the current Swift app dims on blur,
Electron will look subtly wrong unless you emulate it in CSS.
> "The default behavior of native macOS apps with vibrancy is to disable the
> vibrancy when the window is inactive." ... "Electron apps have the vibrancy
> forced to always be active since Electron manually sets the state to
> NSVisualEffectStateActive"
> — https://github.com/electron/electron/issues/16417 (secondary)

Diff B — **[thin, secondary]** Native `vibrancy` and CSS `backdrop-filter: blur()`
do not compose correctly (double/desynced blur). Pick one blur source, not both.
> "[Bug]: Enabling Vibrancy and backdrop-filter blur doesn't render properly" ...
> "However the text in the background gets blurred and not at the same time."
> — https://github.com/electron/electron/issues/39529 (secondary)

Diff C — **[thin, secondary]** Vibrancy view position/size updates round-trip
Chromium→JS→C++, which is the root of resize flicker/lag on the vibrancy layer.
> "There can be an API that allows you to create VisualEffect views and update
> their position and size, but this may have issues with timing, as things like
> element resizes would have to go through chromium to JS and then back to C++."
> — https://github.com/electron/electron/issues/13175 (secondary)

GAP 1 — No official page states an explicit inline mapping table from each
`vibrancy` value to a named NSVisualEffectView material; docs only link Apple's
NSVisualEffectView reference (Claim 1.7). Exact material match will need visual
A/B testing against the current app.

GAP 2 — No source (primary or secondary) quantifies blur-radius or tint deltas
between Electron vibrancy and native. Treat "pixel-perfect" here as
empirically-verified-by-screenshot, not doc-guaranteed.

---

## Section 2 — Custom protocol for local assets (replacing `eos://` WKURLSchemeHandler)

Recommendation: register the scheme privileged before `app.ready`, then
`protocol.handle` it to serve the Vite `dist/`. Serve as a `secure` + `standard`
scheme so the renderer is a secure context and relative URLs resolve. Range and
SSE need manual handling and testing.

Claim 2.1 — `protocol.handle` is the modern registration; handler returns a
`Response`.
> "Register a protocol handler for `scheme`. Requests made to URLs with this
> scheme will delegate to this handler to determine what response should be sent.
> Either a `Response` or a `Promise<Response>` can be returned."
> — https://www.electronjs.org/docs/latest/api/protocol (primary)

Claim 2.2 — `registerSchemesAsPrivileged` must run before `app.ready`, once.
> "This method can only be used before the `ready` event of the `app` module gets
> emitted and can be called only once."
> — https://www.electronjs.org/docs/latest/api/protocol (primary)

Claim 2.3 — What the privileges grant (standard, secure, bypassCSP, ServiceWorker,
fetch, streaming, code cache) — enable each with `true`.
> "Registers the `scheme` as standard, secure, bypasses content security policy
> for resources, allows registering ServiceWorker, supports fetch API, streaming
> video/audio, and V8 code cache. Specify a privilege with the value of `true` to
> enable the capability."
> — https://www.electronjs.org/docs/latest/api/protocol (primary)

Claim 2.4 — Streaming responses require `stream: true`; a handler can return any
readable-stream object (relevant for serving large assets / potential SSE).
> "Protocols that use streams (http and stream protocols) should set
> `stream: true`." ... "It is possible to pass any object that implements the
> readable stream API (emits `data`/`end`/`error` events)."
> — https://www.electronjs.org/docs/latest/api/protocol (primary)

Claim 2.5 — Set a CSP as defense-in-depth; it can be delivered via `<meta>` when
you cannot set an HTTP header (typical for a `protocol.handle`-served SPA).
> "A Content Security Policy (CSP) is an additional layer of protection against
> cross-site-scripting attacks and data injection attacks." ... "CSP allows the
> server serving content to restrict and control the resources Electron can load
> for that given web page."
> — https://www.electronjs.org/docs/latest/tutorial/security (primary)

> "It can be useful in some cases to set a policy on a page directly in the markup
> using a `<meta>` tag."
> — https://www.electronjs.org/docs/latest/tutorial/security (primary)

GAP 3 — **HTTP Range / `206 Partial Content` is NOT documented** for
`protocol.handle`. There is no official quote guaranteeing built-in Range support;
it must be implemented in the handler (parse `Range`, return the byte slice). Verify
before relying on `<video>`/large-asset seeking.

GAP 4 — **SSE / `EventSource` over a custom protocol is NOT documented.** The only
streaming language in the docs concerns `<video>`/`<audio>` buffering. In practice
SSE would require returning a `Response` with a never-closing `ReadableStream`, and
there are open ReadableStream bugs (electron/electron #41872, #39658 per the
subagent's search). **Recommendation:** keep the existing daemon SSE on plain
`http://127.0.0.1:<port>` (fetched from the renderer / main) rather than tunneling
SSE through the custom asset scheme. Serve only static assets via `protocol.handle`.

GAP 5 — The "`secure` scheme = secure context / `window.isSecureContext === true`"
equivalence is **not** stated verbatim in current official docs (the `custom-scheme`
structure page lists fields as bare "Default false."). It is attested only in
secondary sources (electron/electron issue #7670). Treat "register as `secure` to
get a secure context" as **[thin]** and confirm at runtime.

---

## Section 3 — Performance

Recommendation: `backgroundThrottling: false` on the SSE window; single bundled
main file; defer startup work; never block the main thread; consider V8 snapshots
and dropping the default menu. Budget for a higher memory baseline than WKWebView.

Claim 3.1 — `backgroundThrottling` defaults `true` and throttles timers/animations
when backgrounded; disable it so live SSE keeps drawing (the key setting here).
> "Whether to throttle animations and timers when the page becomes background.
> This also affects the Page Visibility API. When at least one webContents
> displayed in a single browserWindow has disabled `backgroundThrottling` then
> frames will be drawn and swapped for the whole window and other webContents
> displayed by it. Defaults to `true`."
> — https://www.electronjs.org/docs/latest/api/browser-window (primary)

Claim 3.2 — Runtime toggle exists too.
> "Controls whether or not this WebContents will throttle animations and timers
> when the page becomes backgrounded. This also affects the Page Visibility API."
> — https://www.electronjs.org/docs/latest/api/web-contents (primary)

Claim 3.3 — The performance tutorial's goal frames the tuning target.
> "This document outlines some of the Electron maintainers' favorite ways to
> reduce the amount of memory, CPU, and disk resources being used while ensuring
> that your app is responsive to user input and completes operations as quickly as
> possible."
> — https://www.electronjs.org/docs/latest/tutorial/performance (primary)

Claim 3.4 — Defer expensive startup work.
> "If you have expensive setup operations, consider deferring those. Inspect all
> the work being executed right after the application starts."
> — https://www.electronjs.org/docs/latest/tutorial/performance (primary)

Claim 3.5 — Never block the main/UI thread.
> "Under no circumstances should you block this process and the UI thread with
> long-running operations." ... "Blocking the UI thread means that your entire app
> will freeze until the main process is ready to continue processing."
> — https://www.electronjs.org/docs/latest/tutorial/performance (primary)

Claim 3.6 — Bundle main-process code to one file so `require()` cost is paid once.
> "we heavily recommend that you bundle all your code into one single file to
> ensure that the overhead included in calling `require()` is only paid once when
> your application loads."
> — https://www.electronjs.org/docs/latest/tutorial/performance (primary)

Claim 3.7 — V8 snapshots speed startup (mechanism, not a single flag).
> "V8 snapshots can be useful to improve app startup performance. V8 lets you take
> snapshots of initialized heaps and then load them back in to avoid the cost of
> initializing the heap."
> — https://github.com/electron/mksnapshot/blob/main/README.md (secondary) **[thin]**

The primary hook for wiring a snapshot into a build is the Fuses doc:
> "The loadBrowserProcessSpecificV8Snapshot fuse changes which V8 snapshot file is
> used for the browser process ... the main process uses the file called
> browser_v8_context_snapshot.bin for its V8 snapshot."
> — https://www.electronjs.org/docs/latest/tutorial/fuses (primary)

Magnitude of win — **[thin, secondary]**:
> "The Atom team reduced startup time by 50% by using V8 snapshots." / "V8 snapshot
> can speed up the require()s for the main process ... by more than 80%."
> — https://github.com/RaisinTen/electron-snapshot-experiment (secondary)

Claim 3.8 — Process model: one main process, one renderer per BrowserWindow. For a
single-window dashboard this means one renderer — keep it that way for lowest
footprint.
> "Each Electron app has a single main process, which acts as the application's
> entry point." ... "Each Electron app spawns a separate renderer process for each
> open `BrowserWindow` (and each web embed)."
> — https://www.electronjs.org/docs/latest/tutorial/process-model (primary)

Claim 3.9 — Disable unused Chromium subsystems via command-line switches before
`ready` (documented example) — e.g. `--disable-http-cache`.
> "You can use app.commandLine.appendSwitch to append them in your app's main
> script before the ready event of the app module is emitted"
> — https://www.electronjs.org/docs/latest/api/command-line-switches (primary)

> "Disables the disk cache for HTTP requests." (`--disable-http-cache`)
> — https://www.electronjs.org/docs/latest/api/command-line-switches (primary)

Claim 3.10 — Drop the default menu when unused (perf + fewer processes).
> "Call `Menu.setApplicationMenu(null)` when you do not need a default menu."
> — https://www.electronjs.org/docs/latest/tutorial/performance (primary; checklist item)

Memory vs WKWebView — **[thin, secondary]**: Electron bundles Chromium so its
baseline is browser-level, materially higher than an OS WebView. Native-WebView
frameworks idle far lower. Budget accordingly; this is the main cost of leaving
WKWebView.
> "Electron bundles a full Chromium engine and Node.js runtime inside each app
> distribution, which means a single Electron app brings browser-level processes"
> — https://windowsforum.com/threads/why-windows-apps-hog-ram-electron-and-webview2-explained.392960/ (secondary)

> Electron "idle memory sits around 150–300MB" (vs a native-WebView framework
> "around 30–50MB at idle")
> — https://blog.openreplay.com/comparing-electron-tauri-desktop-applications/ (secondary)

GAP 6 — No official `/tutorial/snapshots` page exists (the guessed URL 404s);
snapshot speed-up magnitude and the WKWebView memory comparison are secondary-only.

---

## Section 4 — Security baseline (coexisting with the local daemon)

Recommendation: keep all three secure defaults on (`contextIsolation`, `sandbox`,
`nodeIntegration:false`), do privileged/daemon work in main, expose a narrow preload
API via `contextBridge`, and set a CSP. This composes cleanly with a loopback daemon.

Claim 4.1 — `contextIsolation: true` is default (since v12) and recommended for all.
> "Context isolation has been enabled by default since Electron 12, and it is a
> recommended security setting for _all applications_."
> — https://www.electronjs.org/docs/latest/tutorial/context-isolation (primary)

> "Whether to run Electron APIs and the specified `preload` script in a separate
> JavaScript context. Defaults to `true`."
> — https://www.electronjs.org/docs/latest/api/browser-window (primary)

Claim 4.2 — Renderer sandbox is on by default since Electron 20; recommended in all
renderers.
> "Starting from Electron 20, the sandbox is enabled for renderer processes without
> any further configuration."
> — https://www.electronjs.org/docs/latest/tutorial/sandbox (primary)

> "Sandboxing is a Chromium feature that uses the operating system to significantly
> limit what renderer processes have access to. You should enable the sandbox in
> all renderers."
> — https://www.electronjs.org/docs/latest/tutorial/security (primary)

Claim 4.3 — `nodeIntegration` defaults `false`; must not be enabled for content
that isn't fully trusted.
> "Whether node integration is enabled. Default is `false`."
> — https://www.electronjs.org/docs/latest/api/browser-window (primary)

> "Disabling Node.js integration helps prevent an XSS from being escalated into a
> so-called 'Remote Code Execution' (RCE) attack."
> — https://www.electronjs.org/docs/latest/tutorial/security (primary)

Claim 4.4 — Context isolation must be on even with `nodeIntegration:false` to truly
isolate.
> "Even when `nodeIntegration: false` is used, to truly enforce strong isolation and
> prevent the use of Node primitives `contextIsolation` **must** also be used."
> — https://www.electronjs.org/docs/latest/tutorial/security (primary)

Claim 4.5 — Preload + `contextBridge.exposeInMainWorld` is the sanctioned IPC bridge;
expose only what's needed, not raw `ipcRenderer`.
> "The [`contextBridge`] module can be used to **safely** expose APIs from your
> preload script's isolated context to the context the website is running in."
> — https://www.electronjs.org/docs/latest/tutorial/context-isolation (primary)

> "Exposing raw APIs like `ipcRenderer.on` is dangerous because it gives renderer
> processes direct access to the entire IPC event system ... we want the untrusted
> web content to only have access to necessary information and APIs."
> — https://www.electronjs.org/docs/latest/tutorial/security (primary; contains an elision)

Claim 4.6 — Preload always has Node access regardless of nodeIntegration; specify by
absolute path.
> "This script will always have access to node APIs no matter whether node
> integration is turned on or off. The value should be the absolute file path to
> the script."
> — https://www.electronjs.org/docs/latest/api/browser-window (primary)

Claim 4.7 — "Only load secure content" — non-bundled resources over HTTPS.
> "Any resources not included with your application should be loaded using a secure
> protocol like `HTTPS`."
> — https://www.electronjs.org/docs/latest/tutorial/security (primary)

Coexisting with the local daemon (HTTP+SSE): the secure defaults do NOT block a
loopback daemon — the app's own UI is bundled (served via the custom scheme), and
the daemon is reached by fetch/EventSource against `127.0.0.1`. Keep the renderer
sandboxed and route any privileged calls through the preload bridge / main process.

GAP 7 — Official docs do NOT contain a verbatim statement that a localhost/loopback
HTTP daemon is an explicit safe exception to "only load secure content." The
security guidance is framed around *remote/untrusted* content. The loopback-is-fine
position is inference (standard practice), **[thin]** — state it as a design choice,
not a doc guarantee. Two quotes (Claims 4.5) came back with WebFetch ellipses;
re-lift verbatim from the live page before using as strict block quotes.

---

## Section 5 — Native macOS equivalents (replacing the Swift/AppKit shell)

Recommendation: one-to-one Electron API for each AppKit affordance; all live in the
main process.

Claim 5.1 — `Tray` = menu-bar status item (replaces the Swift StatusBar StatusItem).
> "Add icons and context menus to the system's notification area."
> — https://www.electronjs.org/docs/latest/api/tray (primary)

Claim 5.2 — `Notification` = native desktop notifications.
> "Create OS desktop notifications"
> — https://www.electronjs.org/docs/latest/api/notification (primary)

Claim 5.3 — `globalShortcut` = app-wide hotkeys, work without focus.
> "The `globalShortcut` module can register/unregister a global keyboard shortcut
> with the operating system" ... "The shortcut is global; it will work even if the
> app does not have the keyboard focus."
> — https://www.electronjs.org/docs/latest/api/global-shortcut (primary)

Claim 5.4 — `dialog` = native open/save file dialogs.
> "Display native system dialogs for opening and saving files, alerting, etc."
> — https://www.electronjs.org/docs/latest/api/dialog (primary)

Claim 5.5 — `safeStorage` = OS-crypto for secrets; on macOS it is Keychain-backed
(the keychain replacement).
> "This module adds extra protection to data being stored on disk by using
> OS-provided cryptography systems." ... "Encryption keys are stored for your app in
> Keychain Access in a way that prevents other applications from loading them
> without user override."
> — https://www.electronjs.org/docs/latest/api/safe-storage (primary)

Claim 5.6 — `app.requestSingleInstanceLock()` = single-instance enforcement; second
launch fires `second-instance` in the primary.
> "The return value of this method indicates whether or not this instance of your
> application successfully obtained the lock." ... "This event will be emitted
> inside the primary instance of your application when a second instance has been
> executed and calls `app.requestSingleInstanceLock()`."
> — https://www.electronjs.org/docs/latest/api/app (primary)

Claim 5.7 — `app.setAsDefaultProtocolClient(protocol)` = deep-link registration;
macOS delivers URLs via `open-url` and needs `CFBundleURLTypes` in Info.plist.
> "Sets the current executable as the default handler for a protocol (aka URI
> scheme). It allows you to integrate your app deeper into the operating system." ...
> "Emitted when the user wants to open a URL with the application. Your application's
> `Info.plist` file must define the URL scheme within the `CFBundleURLTypes` key."
> — https://www.electronjs.org/docs/latest/api/app (primary)

Claim 5.8 — `app.dock` = macOS dock API (badge/icon/menu).
> "A `Dock | undefined` property ... that allows you to perform actions on your app
> icon in the user's dock."
> — https://www.electronjs.org/docs/latest/api/app (primary)

(No gaps in this section; all primary. Per-method dock quotes — `dock.setBadge()`
etc. — live on `/docs/latest/api/dock` if needed.)

---

## Section 6 — Packaging & distribution on macOS

Recommendation: **Electron Forge** as the primary toolchain (Electron's own tutorial
directs you to it; first-party modules), universal arm64+x64, Developer ID signing,
Hardened Runtime + `allow-jit`, notarize via `notarytool`, `electron-updater` for
updates. Choose electron-builder instead if you need its broader installer/publish
provider matrix out of the box.

Claim 6.1 — electron-builder: complete packaging + installers, with auto-update.
> "A complete solution to package and build a ready-for-distribution Electron app"
> ... "Ship updates seamlessly with `electron-updater`. Supports differential
> updates, staged rollouts, and multiple providers — GitHub Releases, S3, and more"
> — https://www.electron.build/ (primary)

Claim 6.2 — Electron Forge: all-in-one, first-party pipeline with signing/installers.
> "Electron Forge is an all-in-one tool for packaging and distributing Electron
> applications." ... "combines many single-purpose packages to create a full build
> pipeline that works out of the box, complete with code signing, installers, and
> artifact publishing."
> — https://www.electronforge.io/ (primary)

Claim 6.3 — Electron's OWN packaging tutorial directs you to Forge (the basis for
recommending it).
> "Electron does not have any tooling for packaging and distribution bundled into
> its core modules." ... "Electron Forge is an all-in-one tool that handles the
> packaging and distribution of Electron apps." ... "To create a distributable, use
> your project's new `make` script, which runs the `electron-forge make` command."
> — https://www.electronjs.org/docs/latest/tutorial/tutorial-packaging (primary)

Claim 6.4 — Forge uses first-party modules; builder swaps in custom ones (the
architectural trade-off).
> "Forge uses the same core modules used by the greater Electron community (like
> `@electron/packager`)." ... "electron-builder replaces features and modules used by
> the Electron maintainers ... with custom ones."
> — https://www.electronjs.org/docs/latest/tutorial/boilerplates-and-clis (primary)

Claim 6.5 — Universal macOS binary is supported (native on Intel + Apple Silicon).
> "This package takes an x64 app and an arm64 app and glues them together into a
> Universal macOS binary."
> — https://github.com/electron/universal (primary)

> "A **universal binary** contains both x64 and arm64 slices in a single
> executable." ... "It runs natively on Intel Macs and Apple Silicon without Rosetta
> 2 translation."
> — https://www.electron.build/docs/architecture/ (primary)

Claim 6.6 — macOS blocks unsigned apps → Developer ID signing required.
> "Both Windows and macOS prevent users from running unsigned applications."
> — https://www.electronjs.org/docs/latest/tutorial/code-signing (primary)

Claim 6.7 — Notarization is a hard requirement for outside-App-Store distribution
(Gatekeeper checks the ticket).
> "the app needs to be uploaded to Apple for a process called **notarization**, where
> automated systems will further verify that your app isn't doing anything to
> endanger its users."
> — https://www.electronjs.org/docs/latest/tutorial/code-signing (primary)

> "As macOS 10.15 (Catalina), Apple has made notarization a hard requirement for all
> applications distributed outside of the Mac App Store." ... "When the user first
> launches a notarized app, Gatekeeper looks for the app's ticket online."
> — https://github.com/electron/notarize (primary)

Claim 6.8 — Notarization needs Hardened Runtime + entitlements; Electron needs the
JIT entitlement for V8.
> Hardened Runtime "restricts what your app process can do unless you explicitly
> declare entitlements."
> — https://www.electron.build/docs/features/code-signing/notarization/ (primary)

> `com.apple.security.cs.allow-jit` — "Required by Electron (V8 JIT)";
> `com.apple.security.cs.allow-unsigned-executable-memory` — "Required by some
> Electron versions"
> — https://www.electron.build/docs/features/code-signing/notarization/ (primary)

Note — **[thin, secondary]** on the unsigned-memory entitlement: only needed on
Electron ≤11; omit on 12+ to reduce attack surface. Given we target Electron 42,
**do not add** `allow-unsigned-executable-memory`.
> "If you are using Electron 11 or below, you must add the
> com.apple.security.cs.allow-unsigned-executable-memory entitlement too. When using
> version 12+, this entitlement should not be applied as it increases your app's
> attack surface."
> — https://www.forasoft.com/blog/article/the-pain-of-publishing-electron-apps-on-macos-303 (secondary)

Claim 6.9 — Notarization tool is `notarytool` (`altool` deprecated **[thin]**).
> The repository references `xcrun notarytool` as the command-line utility.
> — https://github.com/electron/notarize (primary)

> "Every working pipeline in 2026 uses notarytool. The older `altool` has been
> deprecated."
> — https://www.forasoft.com/blog/article/the-pain-of-publishing-electron-apps-on-macos-303 (secondary)

Claim 6.10 — Auto-update via Squirrel.Mac requires a signed app (ties updates to
signing above).
> "`Squirrel.Mac` requires the app to be signed for automatic updates to work at
> all."
> — https://www.electronjs.org/docs/latest/tutorial/code-signing (primary)

Claim 6.11 — Realistic footprint: >100MB installed, ~80–100MB zipped (primary).
> "it also increases the total disk size of Electron apps (most apps are >100MB)." ...
> "Zipped Electron apps are usually around 80 to 100 Megabytes."
> — https://www.electronjs.org/docs/latest/why-electron (primary)

Larger real-world figures — **[thin, secondary]**: installed `.app` bundles can be
several hundred MB (Chromium ~120–150MB alone).
> "Electron apps ship with their own Chromium, which means a minimum download of
> roughly 150MB even for a basic utility."
> — https://makerstack.co/reviews/electron-review/ (secondary)

GAP 8 — No clean primary prose sentence literally naming "Developer ID Application"
certificate was captured (the code-signing tutorial references generic "signing
certificates"; electron.build shows it only as `spctl` output `source=Notarized
Developer ID`). The Developer ID requirement is well-established but confirm the
exact cert name against
https://www.electron.build/docs/features/code-signing/code-signing-mac/ if a verbatim
quote is required.

GAP 9 — The standalone electron-builder auto-update doc page 404'd on multiple slug
guesses; the auto-update claims are sourced from the electron.build homepage +
electronjs.org code-signing tutorial (both primary). Exact live slug under
`/docs/...` unconfirmed.

GAP 10 — No source uses the literal phrase "Electron officially recommends Forge."
The recommendation rests on Electron's tutorial *directing* you to Forge (Claim 6.3)
and Forge's first-party-module design (Claim 6.4) — framed as such, not as a verbatim
endorsement.

---

## Consolidated gaps & open questions (for the migration owner)

- Vibrancy is the highest pixel-perfect risk: no doc guarantees material/blur/tint
  parity, native-vs-Electron inactive-dim differs, and CSS blur conflicts. Plan a
  screenshot A/B pass against the current Swift window (GAP 1, 2; Diffs A–C).
- SSE and Range over the custom scheme are undocumented (GAP 3, 4). Recommended
  design: serve static assets via `protocol.handle`, keep daemon SSE on
  `http://127.0.0.1` fetched directly. Validate `EventSource` behavior early.
- `secure`-scheme → secure-context and loopback-HTTP-is-safe are both practice, not
  doc-guaranteed (GAP 5, 7). Verify `window.isSecureContext` at runtime.
- V8-snapshot magnitude and WKWebView memory comparison are secondary-only (GAP 6).
- Packaging fine print (Developer ID cert name, auto-update slug, Forge "official"
  wording) needs a confirmation pass (GAP 8–10).

Sibling findings note: no sibling files present in `docs/electron-migration/` at
write time (only this file), so no cross-checking against peer research was possible.
