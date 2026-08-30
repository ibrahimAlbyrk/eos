# Current Eos browser — end-to-end architecture (what an embedded redesign replaces vs reuses)

Read-only map of the agent-driven browser as it exists today, so an Electron
embedded-browser redesign knows exactly what it is replacing and what it must
keep. Every claim is cited `path:line`.

## TL;DR

- The daemon drives **one out-of-process Google Chrome per session**, headless,
  over **raw CDP through `--remote-debugging-pipe`** (no Playwright/Puppeteer).
- The human sees that Chrome as a **JPEG screencast painted onto a `<canvas>`**,
  streamed over a dedicated binary WebSocket `/browser/stream`; the human's
  clicks/keys are forwarded back up the same socket to CDP input.
- Agents drive the exact same Chrome through **16 `browser_*` MCP tools** whose
  core model is an **accessibility-tree snapshot with `@eN` refs**, not pixels.
- **Correction to the brief:** the `127.0.0.1:7401` origin is **not** part of the
  browser feature. It is the `fs-raw` disk-bytes + pdf.js file viewer origin
  (`manager/routes/fs-raw.ts:12`, `manager/shared/config.ts:335`). The browser
  panel renders a canvas, not an iframe, and never touches 7401. See (c).
- The clean seam for the redesign is the **`BrowserEngine` port**
  (`core/src/ports/BrowserEngine.ts`). Everything above it (tools, REST,
  service, snapshot model) is REUSE; the screencast/input-forward/audio half of
  the adapter below it is REPLACE. See (f).

---

## (a) The daemon-side browser engine

**What drives Chromium: raw CDP over a pipe — no Playwright, no Puppeteer.**
The transport is a ~50-line NUL-delimited-JSON client speaking Chrome's
`--remote-debugging-pipe` on the child's fd 3 (write) / fd 4 (read):
`infra/src/browser/cdpPipe.ts:1` (`CdpPipeClient`, class at `cdpPipe.ts:15`).
The rationale is in the header: a pipe never exposes an unauthenticated
`--remote-debugging-port`, which would be full-browser control for anything on
the host (`cdpPipe.ts:1-6`).

**The engine object.** `CdpBrowserAdapter` implements the `BrowserEngine` port
(`infra/src/browser/CdpBrowserAdapter.ts:160`). It owns the Chrome child, the
CDP client, and a per-tab registry (`CdpBrowserAdapter.ts:164-176`).

**Launch — headless, spawned by the daemon.**
- Launch flags live in one function, `chromeLaunchArgs`
  (`CdpBrowserAdapter.ts:112-130`): `--headless=new`, `--remote-debugging-pipe`,
  `--user-data-dir=<profile>`, `--force-device-scale-factor=2` (mandatory or the
  screencast ignores emulated DSF, `CdpBrowserAdapter.ts:117-119`),
  `--autoplay-policy=no-user-gesture-required` (mandatory for audio).
- `launch()` spawns the binary with `stdio: ["ignore","ignore","ignore","pipe","pipe"]`
  for the CDP pipe and wires the `CdpPipeClient` to fds 3/4
  (`CdpBrowserAdapter.ts:219-228`).
- **Headless is final** — the header records that the audio spike confirmed
  `--headless=new` reaches CoreAudio, so the headed off-screen fallback is dead
  (`CdpBrowserAdapter.ts:106-111`). Audio plays straight to the system output
  device; only pictures travel over CDP.
- A **keep-alive `about:blank` target** is created at launch because headless
  Chrome exits when its last target closes; it never enters the tabs map and also
  hosts the full-page-capture stitcher canvas (`CdpBrowserAdapter.ts:279-286`).

**Where the Chrome binary is located.** `binaryPath()` prefers the configured
`browser.chromePath`, else probes `DEFAULT_CHROME_PATHS`
(`/Applications/Google Chrome.app…`, `/Applications/Chromium.app…`)
(`CdpBrowserAdapter.ts:37-40`, `184-188`). Absent binary ⇒ engine state `absent`.

**Which process owns it.** The daemon (Node) owns Chrome via
`BrowserService`, which constructs one `CdpBrowserAdapter` per session through an
`engineFactory` (`manager/container.ts:623-626`,
`manager/services/BrowserService.ts:1-8`). A "session" is the parent-chain **root
worker id** (or `GLOBAL_SESSION`); each session gets its own persistent Chrome
with its own on-disk profile dir so logins survive daemon restarts
(`BrowserService.ts:113-124`, `browserProfileDirFor`). Under
`perSession=false` every key collapses to one shared Chrome
(`BrowserService.ts:186-190`).

---

## (b) The `browser_*` MCP tool surface

16 tools in `manager/tools/defs/browser_*.ts`. Each is a thin handler that
resolves the target tab (`resolveTabId` in `browser_shared.ts:11-24` — omitted
`tabId` ⇒ the **active/foreground tab the human is viewing**, never a first-tab
fallback) and calls a loopback REST route, which lands in a `BrowserService`
method, which calls a `BrowserEngine` primitive (CDP under the hood).

| Tool | REST route (`routes/browser.ts`) | Service method | Underlying automation |
|---|---|---|---|
| `browser_snapshot` | `POST …/snapshot` `:226` | `snapshot` `BrowserService.ts:298` | `Accessibility.getFullAXTree` → `formatAXTree` → `@eN` text |
| `browser_find` | `POST …/find` `:232` | `find` `:308` | a11y tree, name substring/`/regex/` match, ≤10 (`CdpBrowserAdapter.ts:523`) |
| `browser_act` | `POST …/act` `:246` | `act` `:315` | trusted CDP `Input.dispatchMouseEvent`/`DOM.focus` (`CdpBrowserAdapter.ts:547`, `trustedClick` `:971`) |
| `browser_type` | `POST …/act` `:246` | `typeText` `:321` | `DOM.focus` + select + `Input.insertText` (`CdpBrowserAdapter.ts:568`) |
| `browser_fill_form` | `POST …/act` `:246` | `fillForm` `:327` | loops `typeText` per field |
| `browser_press` | `POST …/act` `:246` | `press` `:336` | `Input.dispatchKeyEvent` via `parseChord` (`CdpBrowserAdapter.ts:585`) |
| `browser_scroll` | `POST …/act` `:246` | `scroll` `:342` | trusted `mouseWheel` or container `scrollBy` (`CdpBrowserAdapter.ts:600`) |
| `browser_get` | `POST …/get` `:273` | `get` `:348` | `Target.getTargetInfo` (url/title) or `Runtime` eval (text/value) (`CdpBrowserAdapter.ts:626`) |
| `browser_wait` | `POST …/wait` `:238` | `wait` `:379` | 250ms poll of `textPresent`/`refVisible` |
| `browser_screenshot` | `POST …/capture` `:279` | `capture` `:355` | `Page.captureScreenshot` JPEG → **temp file `{path}`** (text-only channel) |
| `browser_navigate` | `POST …/navigate` `:218` | `navigate` `:283` | `Page.navigate`/`reload`/`navigateToHistoryEntry` |
| `browser_new_tab` | `POST /browser/tabs` `:176` | `openTab` `:215` | `Target.createTarget` (background if a panel is watching) |
| `browser_close_tab` | `DELETE …/{tabId}` `:212` | `closeTab` `:227` | `Target.closeTarget` |
| `browser_tabs` | `GET /browser/tabs` `:158` | `listTabs` `:238` | per-tab `Target.getTargetInfo` + `Page.getNavigationHistory` |
| `browser_show` | `POST /browser/show` `:188` | `setActiveTab` `:263` | sets session "look here" pointer; 3s nag rate-limit; no page mutation |
| `browser_mute` | `POST …/mute` `:297` | `setMuted` `:403` | injected audio-guard force-mute (`CdpBrowserAdapter.ts:846`) |

(Handler line numbers per tool file were enumerated by a sub-scan; the
route/service/engine mappings above are verified directly against
`routes/browser.ts` and `BrowserService.ts`.)

**The `@eN` snapshot model (the heart of the agent contract).**
- `snapshot` pulls the full CDP a11y tree (`Accessibility.getFullAXTree`) and
  formats it with `formatAXTree` (`CdpBrowserAdapter.ts:500-521`).
- `formatAXTree` (`infra/src/browser/snapshotFormatter.ts:107`) emits an
  **indented, ref-annotated accessibility text** — never DOM/outerHTML. It keeps
  interactive roles (`INTERACTIVE_ROLES` `:38`), named landmarks/headings, drops
  generic containers (`SKIP_ROLES` `:54`), and mints an `@eN` ref only on
  actionable/focusable nodes (`snapshotFormatter.ts:136-142`). Token cost is the
  whole point (`snapshotFormatter.ts:1-7`).
- A ref maps `@eN → backendDOMNodeId` in a **per-tab map cleared on every
  main-frame navigation** (`CdpBrowserAdapter.ts:259-270`,
  `Tab.refs` `:138`). Acting on an unknown/stale ref throws `StaleRefError`
  (`CdpBrowserAdapter.ts:932-940`), which the route maps to **HTTP 409 with a
  re-snapshot hint** (`routes/browser.ts:108`) — the subsystem's stated
  worst-case (a silently-wrong click on a recycled node) is thereby prevented
  (`core/src/ports/BrowserEngine.ts:93-98`).
- The per-tab counter never resets, so a ref string is never reused within a
  tab's life (`CdpBrowserAdapter.ts:8-11`).

**Snapshot vs screenshot.** Snapshot = a11y tree with refs, *for acting*.
Screenshot = JPEG pixels written to a temp file, *for the human's eyes / when the
rendering itself is the question*. Shapes live in
`contracts/src/browser.ts:116-121` (snapshot) and `:181-190` (screenshot).

The wire shapes for every tool are the single source of truth in
`contracts/src/browser.ts` (e.g. `BrowserElement` = ref/tag/role/name/box/
locator, never markup, password values redacted — `contracts/src/browser.ts:74-85`).

---

## (c) The streaming / transport pipeline

**Two channels, deliberately split** (`contracts/src/browser.ts:1-6`): JSON
control + agent verbs over loopback REST; **frame bytes only** over a dedicated
binary WebSocket. Frames never travel over SSE.

**The frame WebSocket `/browser/stream`** (`manager/browser-ws.ts:1-9`):
- Upgrade is the **only** WS surface besides the authenticated gateway; wired at
  `manager/daemon.ts:503` (`makeBrowserUpgradeHandler`). Auth = **loopback +
  `?uiToken=`** (the token rides the query string because a browser can't set WS
  handshake headers) (`browser-ws.ts:117-121`).
- **Downstream:** each JPEG frame prefixed by a **16-byte little-endian header**
  (`u32 tabKey=fnv1a(tabId)` · `u32 seq` · `u16 width` · `u16 height` · reserved)
  (`browser-ws.ts:44-53`, `encodeFrameHeader`).
- **Upstream (JSON):** `subscribe` / `resize` / `pause` / `resume` /
  `unsubscribe` / `ack` / `input` (`browser-ws.ts:167-223`).
- **Backpressure DROPS, never queues:** drop when the socket buffer exceeds
  ~1 MB or the client is ≥3 frames behind on acks (`shouldDropFrame`
  `browser-ws.ts:66-68`, mirrors CDP's own max-frames-in-flight of 3). A wedged
  ack window self-heals after 2 s (`healWedgedWindow` `:77-83`). The stream is
  damage-driven, so the next repaint supersedes anything dropped.

**Where frames come from — CDP screencast:**
- `Page.startScreencast` with `format:"jpeg"`, `everyNthFrame:1` (a counter, not a
  rate limiter — 2 drops isolated clicks), quality/maxWidth as the only throttle
  (`CdpBrowserAdapter.ts:440-447`). Responsive streams **1:1 with the panel's
  native device px at q85**; Mobile/Tablet keep fixed q60/1024 profiles
  (`streamGeometry` `:91-104`).
- Each `Page.screencastFrame` is acked immediately, then handed to the tab's
  `onFrame` (`onScreencastFrame` `:899-910`). JPEG bitmap dimensions are parsed
  from the SOF marker so the client can size its canvas before decode
  (`jpegSize` `:1014`).
- `BrowserService.subscribeFrames` does **per-tab refcounted fan-out**: the
  screencast starts on the first subscriber and stops on the last, so a hidden or
  closed panel costs 0 bytes / ~0 CPU (`BrowserService.ts:416-472`). A **stall
  watchdog** (2.5 s no-frame ⇒ restart, 1 s tick) heals a foreground stolen by
  another target (`BrowserService.ts:94-103`, `559-583`).

**Foreground coupling (an artifact of one headless Chrome).** A background CDP
target emits **zero** screencast frames, so the adapter tracks a single
foreground tab and `bringToFront`s a tab whenever a panel subscribes, a capture
runs (flip-then-restore), or a device switches (`CdpBrowserAdapter.ts:171-176`,
`289-300`, `387-396`, `659-683`). New tabs open in the background while a panel
watches, to avoid whiting out the viewer (`CdpBrowserAdapter.ts:289-300`).

**Audio silence hack.** Because headless Chrome keeps playing audio after
`Page.stopScreencast`, a tab with no viewer is force-**silenced** at the engine
(system-level), separate from the user-level **mute**; effective mute = either
(`CdpBrowserAdapter.ts:844-871`, `BrowserService.ts:652-661`).

**The `7401` origin is unrelated to the browser.** `config.daemon.rawPort`
(default 7401) is a **separate HTTP listener** serving raw disk bytes + the
pdf.js viewer (`manager/daemon.ts:519`, `569`; `manager/routes/fs-raw.ts:12-16`).
It exists so untrusted file content runs in an `allow-scripts allow-same-origin`
iframe that **cannot share an origin** with the uiToken-bearing app
(`fs-raw.ts:12-16`). The Electron shell's CSP `frame-src … http://127.0.0.1:7401`
(`app/src/main/index.ts:46`) is for that **file viewer iframe**, not the browser
panel. The browser panel is a `<canvas>` fed by the WS — it has no iframe and no
`7401` dependency.

**REST control surface** (`manager/routes/browser.ts:31-52`): loopback-only,
dual-identity. Identity is derived from **headers alone** — `x-eos-ui-token` ⇒
human (session from `?session=`), else `x-eos-agent-id` validated against the
worker repo and walked to its parent-chain root ⇒ that agent's session
(`resolveBrowserCaller` `:69-85`). Actor decides the experience (agents get a nav
allowlist + header redaction; humans are unrestricted); session decides which
Chrome; per-tab routes fence on the tab's owning session (`fenceTab` `:123-130`).

---

## (d) The UI side — how the panel renders and whether the human can interact

**It is fully interactive, not view-only.** Three mutually-exclusive modes —
`view | annotate | pick` (`app/ui/src/state/browserPanelStore.js:22-23`,
`toggleMode` `:288`).

**Store** (`browserPanelStore.js`): a module singleton keyed by **session**
(`sessions` map `:31`), holding only panel chrome state (tabs, activeTabId, mode,
device, urlDraft, connState). Daemon tab state is truth, mirrored in via SSE
`browser:tabs` / `browser:status` (`applyTabs` `:172`, `applyStatus` `:182`).
All browser HTTP goes through `browserFetch` (adds `x-eos-ui-token`) and the WS
URL is built by `browserStreamUrl` (`:104-107`). Every request carries
`?session=` via `withSession` (`:112-115`).

**Panel** (`app/ui/src/views/browser/BrowserPanel.jsx`): owns the frame-WS
lifecycle — ensure Chrome up (`POST /browser/launch`) → ensure one tab → open
`ws://…/browser/stream` → `subscribe` the active tab → hand the socket to the
canvas (`BrowserPanel.jsx:74-133`, `140-145`). It reports its live pixel size and
**re-subscribes on tab/device switch** and **`resize`s (150 ms debounced)** on
panel resize (`:140-166`); it `pause`s on `document.hidden` and `resume`s on
visible (`:170-178`). Engine-down / disabled / absent states replace the canvas
with a message body (`:198-201`).

**Canvas** (`app/ui/src/views/browser/BrowserCanvas.jsx`): paints binary frames
(`createImageBitmap → drawImage`, latest-frame-wins, ack every dequeued frame via
`makeFramePump`) and **forwards human input back up the same socket**:
`mousedown/up/move`, native non-passive `wheel`, and `keydown/up` are translated
to CDP input events and sent as `{type:"input", event}`
(`BrowserCanvas.jsx:28-103`). Canvas coords are translated to page CSS px via
`canvasToPage` using the viewport the daemon sent on `subscribe`
(`BrowserCanvas.jsx:50-53`). Meta chords stay with the app; everything else goes
to the page (`:88-92`).

Around the canvas: tab strip, nav/URL bar, device menu (Responsive/Mobile/Tablet,
a real CDP re-emulate + reload — `browserPanelStore.js:307-329`), and the
`AnnotationLayer` / `PickerLayer` overlays for annotate/pick modes
(`BrowserPanel.jsx:204-217`). `DeviceFrame` letterboxes emulated viewports.

---

## (e) The WKWebView limitations that shaped this

Two distinct things must not be conflated:

1. **The browser being out-of-process is a daemon-service design choice, not a
   WKWebView workaround.** It is out-of-process so that (i) an **agent** can drive
   it via CDP, (ii) each **session** gets an isolated Chrome + persistent profile,
   (iii) it runs **headless** with audio to the system device, and (iv) the human
   and the agent share the **same** browser. None of that depends on the shell
   being WKWebView — the same design stands under Electron
   (`BrowserService.ts:1-8`, `browser-ws.ts:1-9`).

2. **What WKWebView genuinely forced** was a pile of *shell* workarounds
   (documented in `docs/electron-migration/10-native-shell-analysis.md` §f), plus
   the fact that WKWebView **cannot host an automatable third-party browser view**
   — so the only way to show the human the agent's Chrome was to **pipe pixels
   into a canvas**. Representative shell "weird methods":
   - `-webkit-app-region` ignored ⇒ window drag re-implemented JS→native
     `performDrag` (`10-native-shell-analysis.md:151`, `:49`).
   - `navigator.clipboard.readText` permission-gated ⇒ terminal paste via native
     `NSPasteboard` (`:148`).
   - No `<a download>` on the `eos://` scheme ⇒ silent write-to-Downloads bridge
     (`:85`).
   - `file://` opaque origin ⇒ a custom `eos://app/` scheme just for stable
     `localStorage` (`:35`, `10-native-shell-analysis.md` §a).
   - Page capture didn't composite `backdrop-filter`; DevTools gated behind
     `isInspectable`; `NSBeep` on unhandled keys ⇒ `QuietWindow` subclass
     (`10-native-shell-analysis.md` §f).

**What Electron changes for the browser panel.** Electron *can* embed a real,
automatable Chromium view (`<webview>` / `WebContentsView`) and expose CDP on it
via `webContents.debugger`. That is the capability WKWebView lacked and is the
whole premise of this redesign: the panel could host the page **natively**
instead of painting piped JPEG frames. Note the current Electron shell has **not
yet** done this — the panel is still the canvas-over-WS pipeline
(`BrowserPanel.jsx`, `BrowserCanvas.jsx` unchanged); today Electron only replaced
the *shell* workarounds (`app/src/main/index.ts:96-122`).

---

## (f) SEAMS — replace vs reuse (the redesign's most important output)

**The clean seam is the `BrowserEngine` port** (`core/src/ports/BrowserEngine.ts`).
Everything *above* it is presentation-agnostic and should be **reused verbatim**;
the port's own surface *mixes two concerns* and is where the split happens.

### REUSE — the automation semantics and the agent-facing contract

These are independent of how the human sees the page. Keep as-is:

- **The agent tool contract.** The 16 `browser_*` tools, their prompts, and the
  `contracts/src/browser.ts` request/response shapes. The agent must not notice
  the redesign.
- **The a11y-snapshot + `@eN` ref model.** `snapshotFormatter.ts` (`formatAXTree`),
  the per-tab `@eN → backendNodeId` map, `StaleRefError` → 409 re-snapshot. This
  is built on standard CDP (`Accessibility.getFullAXTree`) and works identically
  against an embedded Chromium reached via `webContents.debugger`.
- **The CDP automation half of the adapter:** `snapshot`, `find`, `act`
  (trusted input), `typeText`, `press`, `scroll`, `get`, `capture`, `navigate`,
  `openTab`/`closeTab`/`listTabs`, `elementAt`, `textPresent`/`refVisible`,
  `setDevice`. All are plain CDP calls; retarget them at the embedded contents.
- **`BrowserService` orchestration** (`manager/services/BrowserService.ts`):
  per-session engine map, tab registry (`tabSessions`), active-tab pointer,
  nav-origin allowlist (`enforceNavPolicy`), agent/human actor split,
  `redactForAgent`, `browser:activity`/`present` events, `browser_show` nag guard.
- **The REST control surface** (`manager/routes/browser.ts`): identity derivation,
  session fencing, error→status mapping. (The `input` upstream verb is the one
  exception — see REPLACE.)
- **The panel's non-canvas chrome:** tab strip, nav/URL bar, device menu,
  session keying, engine-state messaging (`browserPanelStore.js`, `BrowserPanel`
  minus the canvas + WS-frame wiring).

### REPLACE — the out-of-process rendering, transport, and its artifacts

All of this exists only because the page renders in a *different* process from
the panel. An embedded browser view renders natively and makes it dead weight:

- **The JPEG screencast pipeline end-to-end:** `Page.startScreencast` →
  `onScreencastFrame` → refcounted fan-out → `/browser/stream` 16-byte-header WS
  → `makeFramePump` → `<canvas>` `drawImage`. (`CdpBrowserAdapter.ts:387-447`,
  `899-910`; `manager/browser-ws.ts`; `BrowserCanvas.jsx`.) Replaced by native
  compositing.
- **The backpressure/ack machinery:** `shouldDropFrame`, `healWedgedWindow`,
  MAX_UNACKED window, the stall watchdog (`browser-ws.ts:66-83`,
  `BrowserService.ts:559-583`). No frames ⇒ no flow control.
- **Human input forwarding:** `BrowserCanvas` input events → WS `input` →
  `BrowserService.input` → `dispatchInput` → CDP `Input.dispatch*`
  (`BrowserCanvas.jsx:46-103`, `CdpBrowserAdapter.ts:456-496`). An embedded
  webview receives native mouse/keyboard directly.
- **Panel-coupled viewport streaming:** `DisplaySize` plumbing,
  `startScreencast(display)`, `setDisplaySize`/`resizeViewport`, `streamGeometry`,
  the `subscribe/resize/pause/resume` control verbs
  (`BrowserEngine.ts:37-46`, `115-121`; `BrowserService.ts:474-489`). A native
  view sizes itself; device emulation can use the embedded contents' own CDP.
- **The audio-to-system-output workarounds:** `audioGuard`, `setSilenced`,
  silence-on-last-unsubscribe (`CdpBrowserAdapter.ts:844-879`,
  `BrowserService.ts:445`, `652-661`). A rendered webview plays audio natively;
  "silence when unviewed" is only needed because a headless tab keeps playing.
- **The single-foreground artifacts:** keep-alive target, background-open rule,
  `bringToFront` on subscribe, capture flip/restore, foreground/background
  frame-zero handling (`CdpBrowserAdapter.ts:171-176`, `279-300`, `659-683`).
  Per-tab native views have no shared-screencast contention.
- **Full-page capture stitching** in the keep-alive document
  (`CdpBrowserAdapter.ts:685-737`). An embedded `webContents.capturePage()` (or a
  single CDP `captureBeyondViewport`) removes the tiling/stitch.

### The central redesign tension to resolve

Today **one** `BrowserEngine` port interleaves *automation* (REUSE) and
*presentation* (REPLACE) against **one** headless Chrome that both the agent and
the human share (`BrowserService.ts:1-8`). If the browser moves into the shell's
renderer as an embedded view, the redesign must decide **where the agent's CDP
session attaches** so that "agent and human drive the *same* browser" still holds
— e.g. the daemon attaches its automation CDP to the shell-embedded contents, or
the shell relays. Concretely: split the port into an **automation** interface
(kept, retargeted) and a **presentation** interface (`startScreencast`,
`stopScreencast`, `setDisplaySize`, `dispatchInput`, `subscribeFrames`) that the
embedded lane **no longer implements at all**. That split is the redesign's first
architectural decision, and the `BrowserEngine` port is exactly where to make it.
