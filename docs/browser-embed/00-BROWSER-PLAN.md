# 00 — Embedding a real browser in the Electron Eos app: the design plan

Status: design report (no code changed). Date: 2026-08-30.
Synthesizes: `10-current-architecture.md` (the current daemon-side browser),
`20-electron-embedding.md` (Electron embedding research), `30-agent-automation.md`
(agent-control architecture). Citations are `(10 §x)` / `(20 §x)` / `(30 §x)` into
those docs, plus `path:line` into the repo where load-bearing.

---

## A. Executive summary

Replace the human's JPEG-screencast-on-a-canvas with a **real, natively rendered
Chromium view embedded in the Electron app** — one `WebContentsView` per tab, owned by
the Electron **main** process (20 §1) — while the agent keeps driving the *same* pages
through the **unchanged** `browser_*` MCP tools. The daemon's `BrowserService`, routes,
contracts, and all 16 tools stay frozen; the only thing that changes underneath them is
the concrete `BrowserEngine` behind the existing factory line
(`manager/container.ts:624`): when the app registers itself as the **browser host**,
the factory returns a new `RemoteBrowserEngine` that RPCs each port method over a
daemon↔app control channel to a `MainWebContentsDriver` in the app; when no host is
registered (headless daemon, CI, cron), it returns today's `CdpBrowserAdapter`
unchanged (30 §0, §6).

The automation semantics — a11y-tree snapshots, `@eN` refs, `StaleRefError`, trusted
CDP input — transplant near-verbatim from `CdpBrowserAdapter` onto
`webContents.debugger`, which speaks the same protocol through a different door
(30 §5). The entire screencast pipeline (frame WS, backpressure, input forwarding,
audio guard, foreground juggling) is deleted from the human path — native compositing
replaces it (10 §f REPLACE).

Design principles honored:
- **DIP** — the `BrowserEngine` port (`core/src/ports/BrowserEngine.ts`) stays the
  single seam; nothing above it changes; a second adapter slots in behind it (30 §3 B2).
- **SRP** — main process = view lifecycle + native composite; daemon = automation
  semantics, policy, session identity, tools; renderer = UI chrome + layout reporting
  only (20 §5, 30 §6).
- **Reuse over rewrite** — tools, contracts, REST, snapshot formatter, key parsing,
  service orchestration, and the panel's non-canvas chrome are reused verbatim
  (10 §f REUSE); the new code is one adapter pair + one control channel, nothing more.

## B. Current architecture recap and the REUSE / REPLACE seam

What exists today (10 §a–d):
- The daemon spawns **one out-of-process headless Chrome per session** and drives it
  over **raw CDP through `--remote-debugging-pipe`** (`infra/src/browser/cdpPipe.ts`,
  `CdpBrowserAdapter.ts`). A "session" is the parent-chain root worker id (or
  `GLOBAL_SESSION`), each with a persistent on-disk profile (10 §a).
- The human sees that Chrome as a **JPEG screencast painted on a `<canvas>`** over the
  binary WS `/browser/stream`; clicks/keys are forwarded back up the same socket into
  CDP `Input.dispatch*` (10 §c–d). Fully interactive, but a video of a separate
  process with synthetic input.
- Agents drive the same Chrome via **16 `browser_*` MCP tools** → loopback REST
  (`manager/routes/browser.ts`) → `BrowserService` → `BrowserEngine` port. The core
  agent model is the **a11y-tree snapshot with `@eN` refs** (`snapshotFormatter.ts`),
  never pixels; stale refs raise `StaleRefError` → HTTP 409 with a re-snapshot hint
  (10 §b).
- Correction carried from 10 TL;DR: `127.0.0.1:7401` is the **fs-raw/pdf.js file
  viewer** origin, unrelated to the browser panel (which is a canvas, not an iframe).

The seam (10 §f) — this plan's ground truth:

REUSE (presentation-agnostic; agents must not notice the redesign):
- The 16 `browser_*` tools, their prompts, and `contracts/src/browser.ts` shapes.
- The a11y-snapshot + `@eN` model: `snapshotFormatter.ts` (`formatAXTree`), per-tab
  `@eN → backendDOMNodeId` map cleared on main-frame navigation, `StaleRefError` → 409.
- The CDP automation half of the adapter: `snapshot`, `find`, `act`, `typeText`,
  `press`, `scroll`, `get`, `capture`, `navigate`, tab ops, `elementAt`, `wait`
  probes, `setDevice` — all plain CDP, retargeted at the embedded contents.
- `BrowserService` orchestration: per-session engine map, tab registry, active-tab
  pointer, nav allowlist (`enforceNavPolicy`), agent/human actor split,
  `redactForAgent`, activity/present events, `browser_show` nag guard.
- The REST control surface: identity derivation, session fencing, error→status maps.
- The panel's non-canvas chrome: tab strip, nav/URL bar, device menu, session keying,
  engine-state messaging (`browserPanelStore.js`, `BrowserPanel` minus canvas + WS).

REPLACE (exists only because the page renders in a different process; dead weight
under an embedded view):
- The JPEG screencast pipeline end-to-end (`Page.startScreencast` → refcounted fan-out
  → `/browser/stream` 16-byte-header WS → `makeFramePump` → canvas).
- The backpressure/ack machinery, stall watchdog.
- Human input forwarding (`BrowserCanvas` events → WS `input` → CDP dispatch).
- Panel-coupled viewport streaming (`DisplaySize`, `resize`/`pause`/`resume` verbs).
- The audio-to-system-output workarounds (`audioGuard`, `setSilenced`).
- Single-foreground artifacts (keep-alive target, background-open rule,
  `bringToFront` juggling, capture flip/restore).
- Full-page capture tile-stitching in the keep-alive document.

## C. Target architecture — the embedded view and the human's chrome

### Ownership and tab/session model

- The Electron **main process owns every browser view** — a `WebContentsView` is a
  main-process object and the renderer never receives a `webContents` handle
  (20 §1, §5; 30 §2). A `BrowserHost` module in `app/src/main/browser/` holds:
  `sessionKey → { partition, tabs: Map<tabId, { view, debugger }> }`.
- **One `WebContentsView` per tab**, attached via `win.contentView.addChildView`,
  sized with `setBounds`; tab switching = re-`addChildView` (moves to top) / hide via
  `setVisible(false)` or `removeChildView` (20 §1, §4).
- **Per-session isolation via `partition`**: each Eos session gets
  `persist:eos-browser-<sessionKey>` so cookies/logins are isolated per session and
  survive restarts — the embedded-lane equivalent of today's per-session Chrome
  profile dir (20 §2; 10 §a `browserProfileDirFor`). N tabs ≈ N renderer processes;
  cap or discard inactive views if memory demands (20 §4, open question I-6).

### Security posture

- Browser views run sandboxed, `contextIsolation:true`, `nodeIntegration:false`,
  **no preload** that exposes app APIs, on a partition distinct from the app's
  `eos://` session (20 §3).
- **`setPermissionRequestHandler` MUST be installed** on every browser partition —
  Electron auto-approves all permission requests otherwise (20 §3). Initial policy:
  deny camera/mic/geolocation/notifications; a user-prompt flow is a later, explicit
  addition (open question I-7).
- **`setWindowOpenHandler` returns `{ action: 'deny' }`** and opens the requested URL
  as a new in-app tab, so popups become tabs (20 §2).
- **Navigation fencing**: the app's own `eos://` renderer stays fenced as it is today;
  browser views get `will-navigate`/`will-redirect` guards only to block privileged
  schemes (`eos://`, `file://`). Agent navigation policy (origin allowlist) remains
  **daemon-side** in `BrowserService.enforceNavPolicy` — reused, not duplicated
  (20 §3; 10 §f REUSE).
- **Downloads**: `will-download` on the partition session routes to the OS Downloads
  dir with a UI notification (20 §2).

### Main↔renderer preload IPC — scope decision

Doc 20 §5 sketches a renderer→main verb API covering nav/tabs. This plan **narrows
it**: all *state-changing* browser verbs (new/close/switch tab, navigate,
back/forward, mute, device) keep flowing **renderer → daemon REST → engine**, exactly
as `browserPanelStore.js` does today (10 §d, §f REUSE). Rationale: the daemon is the
single authority for tab state, the active-tab pointer, policy, and SSE
`browser:tabs`/`browser:status` fan-out (30 §6 SRP); routing human verbs around it
would force the main process to replicate that bookkeeping — a DRY violation. The
panel store and its REST calls are thereby reused verbatim; only the canvas dies.

What the preload IPC **does** carry is the one thing the daemon has no business in —
**geometry and visibility** of a native layer (20 §4):

```ts
// app preload — layout/z-order channel only; no webContents, no nav verbs
contextBridge.exposeInMainWorld('eosBrowserView', {
  setBounds:  (rect: {x,y,width,height}) => ipcRenderer.send('browserView:setBounds', rect),
  setVisible: (visible: boolean)         => ipcRenderer.send('browserView:setVisible', visible),
  overlayOpen:(open: boolean)            => ipcRenderer.send('browserView:overlay', open),
});
```

The renderer measures the panel rect (ResizeObserver) and reports it; main
`setBounds`es the active view to track it. Tab *state* continues to arrive in the
renderer over daemon SSE, unchanged.

### Layout / z-order strategy for a native view under React

A `WebContentsView` is a native Chromium layer, not a DOM node — React HTML cannot
draw on top of it (20 §4, the key gotcha). Strategy:
- The `BrowserPanel` renders a **placeholder rectangle** (replacing the canvas); main
  positions the active view over that rect via the IPC above.
- Anything that must appear **above** the browser region (modals, dropdown menus,
  command palette, toasts overlapping the rect) triggers `overlayOpen(true)` → main
  hides the view (`setVisible(false)` — cheaper than detach) for the overlay's
  lifetime, restoring on close (20 §4 mitigation list).
- Hiding the view also mutes it (`setAudioMuted`) to preserve today's
  "silence when unviewed" intent natively (30 R8).
- Z-order between multiple tabs is child-view order: re-`addChildView` brings the
  active tab forward (20 §4).

## D. Agent control — the crux

### The seam and the two adapters

`BrowserEngine` (`core/src/ports/BrowserEngine.ts`) remains **the single seam**
(10 §f; 30 §0). The `browser_*` tools → REST → `BrowserService` chain never touches a
browser directly; the concrete driver is chosen at exactly one line,
`manager/container.ts:624` (verified in this checkout):

```ts
engineFactory: (sessionKey) =>
  appHost.isRegistered()
    ? new RemoteBrowserEngine(appHost.channelFor(sessionKey))  // embedded WebContentsView
    : new CdpBrowserAdapter({ ... })                           // headless fallback (today, unchanged)
```

- `RemoteBrowserEngine` (new) — `implements BrowserEngine`; a thin RPC proxy: each
  port method becomes **one** control-channel round trip. Proxying at the port, not at
  raw CDP, is deliberate: a single `browser_act` is ~5 sequential CDP calls
  (`DOM.resolveNode` → `DOM.getBoxModel` → three `Input.dispatch*`,
  `CdpBrowserAdapter.ts:963-977`); a CDP-level proxy would pay 5 cross-process hops
  per click, a port-level proxy pays 1 (30 §0, §3 — B2 chosen over B1). B1 is also
  structurally wrong for Electron: the current adapter multiplexes N tabs over one
  pipe by CDP `sessionId`, but each Electron tab is its own `webContents` with its own
  `debugger` — there is no single connection to multiplex (30 §5 difference 1).
- `MainWebContentsDriver` (new, app-side, `app/src/main/browser/`) — `implements
  BrowserEngine` against `WebContentsView` + `webContents.debugger`. It imports the
  **pure** modules `infra/src/browser/snapshotFormatter.ts` and `keys.ts` directly
  (entrypoint→infra is the allowed lint direction), so no automation logic is
  duplicated — only re-hosted (30 §3 B2 mitigation, §6 DRY).
- `CdpBrowserAdapter` is **kept unchanged** as the headless fallback — daemons with no
  GUI (CI, `eos start` without the app, cron/remote) keep working (30 §0, §8).

Factory choice is **per-engine-launch**: a session's engine is picked when it
launches; there is no live migration of an already-running engine's tabs between
lanes. If the app quits mid-session, `RemoteBrowserEngine` surfaces `onExit` (channel
closed) and the next launch re-evaluates the factory — same failure shape as a Chrome
crash today (30 R9; `BrowserEngine.ts` onExit).

### The control channel

Direction: **the app connects to the daemon**, matching the only client relationship
that exists today (app is already the daemon's HTTP/SSE/WS client; the daemon may be
*adopted* — running before the app — so the daemon can't dial out; and the app's
single-instance lock guarantees at most one host, so view ownership is never
contested) (30 §2, §6).

- **Transport**: a persistent WS the app main process opens against the daemon at a
  new upgrade route `/browser/host`, wired beside the existing `/browser/stream`
  handler and gated the same way (loopback + `uiToken`; over `EOS_DAEMON_SOCK` when
  present, per the control-plane rule) (30 §6; `manager/browser-ws.ts:117` gate;
  CLAUDE.md unix-socket note).
- **Registration handshake**: on connect the app sends
  `{ type:"register", role:"browser-host", appVersion, pid }`; the daemon validates,
  flips the host registry, and acks `{ type:"registered" }`. Socket close ⇒
  deregister ⇒ every live `RemoteBrowserEngine` fires `onExit`; the factory falls back
  to headless on next launch.
- **RPC frames** (daemon → app): `{ id, sessionKey, method, args }` where `method` is
  a `BrowserEngine` method name and `args` its JSON-serializable parameters. Replies:
  `{ id, ok:true, result }` or `{ id, ok:false, error:{ name, message } }`. `error.name`
  is preserved so `RemoteBrowserEngine` can rehydrate **typed** errors —
  `StaleRefError` must survive the hop for the route's 409 + re-snapshot mapping to
  keep working (`routes/browser.ts:108`; 10 §b; 30 §1 invariant).
- **Events** (app → daemon, unsolicited): `{ type:"event", sessionKey, event, payload }`
  for `tabsChanged`, `exit`, `activeTabChanged`, `tabCrashed` — feeding the port's
  existing `onTabsChanged`/`onExit` callbacks and the active-tab pointer
  (30 §6; `BrowserEngine.ts:152-153`).
- **Binary result note**: `capture` returns image bytes; the driver writes the JPEG to
  a temp file app-side and returns `{ path }` — the same text-only-channel shape the
  tool already has (10 §b `browser_screenshot`), so no binary framing is needed on the
  channel.

### Per-session / per-tab targeting

`BrowserService` already keys engines by `sessionKey` (10 §a); every RPC frame carries
it. App-side, the `BrowserHost` resolves `sessionKey → SessionViews` (partition +
tab map) and `tabId → { view, debugger }`; `tabId` is minted by the driver at
`openTab` and returned through the port, exactly as the CDP `targetId` is today. The
"omitted tabId ⇒ the active tab the human is viewing, never a first-tab fallback"
rule stays **daemon-side** in `resolveTabId`/`BrowserService` — unchanged (10 §b;
30 R4).

### The automation transplant

`webContents.debugger` speaks the same CDP the adapter already uses —
`attach('1.3')`, `sendCommand(method, params)`, a `message` event — the exact
`send`/`on` shape `CdpBrowserAdapter` consumes; all the domains the verbs need
(`Accessibility`, `DOM`, `Runtime`, `Input`, `Page`, `Emulation`) are Chromium-level
and available (30 §5). The verb bodies transplant near-verbatim; the two real
differences are (1) per-tab debugger instead of `sessionId` multiplexing — absorbed by
the tab map above — and (2) screencast becomes unnecessary for the human path (30 §5).
Where a **native** `webContents` method is strictly simpler, the driver uses it:
`loadURL`/`reload`/`navigationHistory.*` for navigation (goBack/goForward on
WebContents are deprecated — 20 §2), `capturePage` for viewport shots,
`setAudioMuted`/`isCurrentlyAudible` for mute (replacing the injected audio-guard with
a one-liner), `executeJavaScript` for text probes (30 §4).

Agent input stays on **CDP `Input.dispatch*`** — never `sendInputEvent`, which
requires the window to be focused and would make agent actions steal or depend on OS
focus (30 R2). This keeps the agent able to drive a background Eos window, exactly as
today.

## E. SOLID / clean-design summary

- **DIP** — the port/adapter boundary: `core`'s `BrowserEngine` is the abstraction;
  `CdpBrowserAdapter` (infra) and `MainWebContentsDriver` (app) are the two
  concretions; the daemon depends only on the port via `RemoteBrowserEngine`. The
  selection is one factory expression — textbook OCP: extension without modifying
  service/routes/tools/tests (30 §0, §6).
- **SRP** — daemon keeps what is policy and identity (nav allowlist, session fencing,
  dual-identity actors, redaction, activity/timeline events, active-tab semantics);
  the app main process keeps what is native (view lifecycle, compositing, debugger,
  permissions, downloads, window-open); the renderer keeps only UI chrome and layout
  reporting (30 §6; 20 §5; §C above).
- **ISP applied by deletion, not by new interfaces**: the port's presentation half —
  `startScreencast`/`stopScreencast`/`setDisplaySize`/`dispatchInput` and the
  frame-subscription path — exists only to ship pixels to a remote canvas (10 §f).
  Default decision: **delete those methods from the port** once M5 lands, so both
  adapters implement one lean automation interface. If open question I-5 (remote/web
  viewer requirement) resolves to "keep", the presentation half instead becomes a
  separate optional capability interface implemented only by `CdpBrowserAdapter` —
  the split doc 10 §f names as the first architectural decision. Either way the
  embedded lane never implements it.
- **DELETED** (with M5): `manager/browser-ws.ts` (frame WS, 16-byte header,
  backpressure, ack window, wedge healing), `BrowserService.subscribeFrames` fan-out +
  stall watchdog, `BrowserCanvas.jsx` + `makeFramePump` + input forwarding,
  `audioGuard`/`setSilenced`, keep-alive target + `bringToFront`/background-open/
  capture-flip foreground artifacts, full-page tile stitching (10 §f REPLACE) — the
  headless fallback retains only the automation half it still needs.
- **Why this stays minimal**: exactly two new named things (`RemoteBrowserEngine`,
  `MainWebContentsDriver`) plus one channel; no new abstraction layers, no
  speculative config, no tool or contract churn; pure logic is imported, not copied.
  Net LOC is expected to go **down** once the screencast machinery is deleted.

## F. Tool → embedded implementation mapping

The agent-facing surface is **16 `browser_*` tools** (`manager/tools/defs/`,
`browser_shared.ts` is a helper; doc 30's "17" also counted port-level ops — listed
separately below). Tool contracts, REST routes, and `BrowserService` methods are
identical in both lanes; only the right-hand column is new. (Reused from 30 §1/§4.)

| `browser_*` tool | Port method | Embedded implementation (`MainWebContentsDriver`) |
|---|---|---|
| `browser_navigate` | `navigate` | `loadURL` / `reload` / `navigationHistory.goToIndex` (native; goBack/goForward deprecated on WebContents — 20 §2) |
| `browser_new_tab` | `openTab` | `new WebContentsView({webPreferences:{partition,…}})` → `addChildView` → `debugger.attach('1.3')` → `Page/DOM/Accessibility.enable` → `loadURL` |
| `browser_close_tab` | `closeTab` | `removeChildView` + `webContents.close()` |
| `browser_tabs` | `listTabs` | `getURL()`/`getTitle()`, `navigationHistory.canGoBack/Forward`, `isCurrentlyAudible()` (native) |
| `browser_snapshot` | `snapshot` | CDP `Accessibility.getFullAXTree` via `debugger` → **unchanged** `formatAXTree` → `@eN` text |
| `browser_find` | `find` | same tree + role/name filter (unchanged logic) |
| `browser_act` | `act` | CDP `DOM.focus` / `Runtime.callFunctionOn` / `DOM.getBoxModel` + **trusted** `Input.dispatchMouseEvent` — identical sequences |
| `browser_type` | `typeText` | CDP `DOM.focus` + `Input.insertText` |
| `browser_fill_form` | (loops `typeText`) | as above |
| `browser_press` | `press` | CDP `Input.dispatchKeyEvent` via unchanged `parseChord` (`keys.ts`) |
| `browser_scroll` | `scroll` | CDP trusted `mouseWheel` / container `scrollBy` eval |
| `browser_get` | `get` | native `getURL`/`getTitle`; `executeJavaScript` or CDP `Runtime` for ref-scoped text/value |
| `browser_wait` | `textPresent`/`refVisible` | `executeJavaScript` poll / CDP `DOM.getBoxModel` |
| `browser_screenshot` | `capture` | `webContents.capturePage()` (viewport); CDP `Page.captureScreenshot` + `captureBeyondViewport` for full page (spike I-3) |
| `browser_show` | (service-level `setActiveTab`) | bring view to front (`addChildView` re-add) + `win.show()/focus()`; keep the 3s nag rate-limit daemon-side |
| `browser_mute` | `setMuted` | native `webContents.setAudioMuted` — deletes the injected audio-guard |

Port-level ops that are not tools (also in 30 §1):

| Port op | Embedded implementation |
|---|---|
| `elementAt` (picker) | CDP `DOM.getNodeForLocation` + `Accessibility.getPartialAXTree` |
| `setDevice` (device emulation) | CDP `Emulation.setDeviceMetricsOverride`/`setUserAgentOverride` + reload — now resizes a *visible* view; see G/R7 |
| `startScreencast` / `dispatchInput` / `setDisplaySize` | **not implemented in the embedded lane** — human path is native (§E deletion) |

**The `@eN` invariant holds across every row**: refs are minted per tab
(`@eN → backendDOMNodeId`), the map is cleared on every main-frame navigation
(CDP `Page.frameNavigated` on the debugger, same signal as today), the counter never
resets within a tab's life, and a stale ref raises `StaleRefError` → typed error over
the channel → HTTP 409 + re-snapshot hint (10 §b; 30 §1, R5). This logic is pure and
moves with the driver unchanged.

## G. Human + agent sharing one real browser — risks and mitigations

Now the human's input is native and concurrent, not synthetic — this is where the
embedded design is genuinely harder than the screencast (30 §7). Numbering follows 30.

- **R1 Native z-order/clipping.** The view floats above the React DOM at its
  `setBounds` rect. Mitigation: placeholder-rect tracking + `setVisible(false)` on
  panel hide / overlay open / tab switch (§C layout strategy; 20 §4).
- **R2 Focus.** `sendInputEvent` needs a focused window ⇒ unusable for the agent.
  Agent input stays on CDP `Input.dispatch*`, which injects regardless of OS focus;
  the human uses the native view. Two cleanly separated input paths (30 R2).
- **R3 Simultaneous input.** An agent click can land mid-drag. Mitigations:
  (1) surface "agent is driving" in the panel chrome from the existing
  `browser:activity` events; (2) a per-`webContents` mutex in the driver serializes
  agent verbs; (3) any human-lock is advisory only — never hard-block the human
  (30 R3).
- **R4 Active-tab semantics.** Omitted `tabId` ⇒ the tab the human is viewing, with
  refuse-rather-than-guess (409) when none. The app reports the shown view over the
  channel (`activeTabChanged`) so the daemon's pointer is exact; no first-tab
  fallback regression (30 R4; 10 §b).
- **R5 Ref sync under human navigation.** The human can navigate between an agent's
  snapshot and act. Already solved by design: main-frame navigation clears the ref
  map and later use raises `StaleRefError` → 409. Wire the driver's ref-clear to CDP
  `Page.frameNavigated` (and treat `did-navigate` as a belt-and-braces signal)
  (30 R5).
- **R6 Debugger ↔ DevTools exclusivity.** Opening DevTools on an attached
  `webContents` terminates the debugger session (single CDP client per target).
  Mitigation: keep the agent's debugger attached for the view's lifetime, handle
  `detach` gracefully (fail in-flight commands, re-attach), and gate human DevTools on
  the embedded view behind an explicit detach-and-pause affordance (30 R6, §5 caveat).
- **R7 Device emulation is now visible.** `setDevice` re-emulates and reloads a view
  the human is watching. Make it an explicit, visible mode change in the panel chrome
  (the device menu already exists — 10 §d); UX detail is open question I-8 (30 R7).
- **R8 Audio.** Native playback; mute = `setAudioMuted`; "silence when unviewed" =
  mute on `setVisible(false)`. The injected audio-guard machinery is deleted (30 R8).
- **R9 Crash isolation.** Renderer crashes are process-isolated, but view lifecycle is
  app-owned: handle `render-process-gone` per view and report `tabCrashed`/`exit` over
  the channel so the daemon surfaces it like today's `onExit` (30 R9).

## H. Phased implementation roadmap

Invariant across all milestones: the `browser_*` tool contracts,
`contracts/src/browser.ts`, and the REST routes do **not** change. The canvas/WS path
keeps working until M5, so each milestone ships without breaking the current panel.

File locations: app-side code in `app/src/main/browser/` (`BrowserHost`, `TabManager`,
`MainWebContentsDriver`) + a preload verb file; daemon-side `RemoteBrowserEngine` in
`infra/src/browser/` (constructed with a transport interface so infra gains no manager
dependency) with the channel server in `manager/` beside `browser-ws.ts`; the factory
edit at `manager/container.ts:624`; renderer edits confined to
`app/ui/src/views/browser/` + `browserPanelStore.js`.

- **M1 — Embed a `WebContentsView` + human chrome.** BrowserHost, one view, partition,
  permission handler (deny-all), window-open→deny, placeholder rect + bounds/visible
  IPC, tab strip/URL bar driving daemon REST as today (against a stub local tab list
  if needed). *Gate:* browse real sites natively inside the panel region; open a
  modal/menu over the region — no occlusion artifact (manual checklist); app suite
  (`cd app/ui && npm test`) green.
- **M2 — Host registration + `RemoteBrowserEngine` (launch/openTab/navigate/
  snapshot).** Channel server + handshake; factory branch at `container.ts:624`;
  driver implements the read path. *Gate:* with the app running, `browser_snapshot`
  via MCP returns `@eN` a11y text of the embedded page; kill the app mid-session →
  `onExit` fires and the next launch falls back to `CdpBrowserAdapter`; existing
  manager suite (`cd manager && npm test`) green.
- **M3 — Act/input + `@eN` parity.** `act`/`typeText`/`press`/`scroll`/`get`/`wait`/
  `find`, typed-error propagation. *Gate:* a fixture-page parity script runs the verb
  matrix against both adapters with equivalent results; stale-ref scenario returns
  409 + re-snapshot hint through the full tool path; agent click lands while the Eos
  window is not the OS foreground window (R2 check).
- **M4 — Tabs, sessions, downloads, permissions, the rest.** Multi-tab z-order +
  active-tab reporting, per-session partitions, popup→tab, `will-download`, native
  mute, `setDevice`, `elementAt`, `capture` (viewport + full-page spike result).
  *Gate:* two sessions show isolated cookies; popup opens as a tab; permission request
  denied by default; download lands; `browser_tabs`/`browser_show`/`browser_mute`
  behave per contract.
- **M5 — Delete the screencast path; finalize fallback wiring.** Remove
  `browser-ws.ts`, `subscribeFrames`/watchdog, `BrowserCanvas` + frame pump + input
  forward, audio guard, foreground artifacts, presentation port methods (per §E
  decision); keep `CdpBrowserAdapter`'s automation half intact. *Gate:* repo grep for
  the deleted symbols is empty; `npm run lint` + all suites green; a **headless**
  daemon (no app) still serves every `browser_*` tool via the fallback.
- **M6 — Parity audit.** Run the full 16-tool matrix end-to-end on the embedded lane
  (incl. `fill_form`, `wait`, screenshots, stale-ref, active-tab-omitted semantics,
  session fencing), compare against the pre-migration behavior notes in 10 §b.
  *Gate:* audit checklist fully green; the backend-kind guard test still passes
  (no `kind`-literal branching crept in — CLAUDE.md rule).

## I. Risks and open questions

Folded in from 30 §9 (spikes) and 20 §Gaps; nothing invented beyond the sources.

1. **Port-over-IPC latency** for chatty verbs (`act`, `fill_form`) over the loopback
   WS — expected imperceptible (1 hop per verb) but must be measured in M3 (30 §9.1).
2. **`Accessibility.getFullAXTree` parity on a *visible* `WebContentsView`** via
   `webContents.debugger` — `formatAXTree` depends on the node shape matching
   headless output; verify in the M2 gate (30 §9.2).
3. **Full-page capture**: does `Page.captureScreenshot` + `captureBeyondViewport` work
   on an embedded view, or is the tile-stitcher (or a hidden clone) still needed?
   Spike in M4 (30 §9.3).
4. **Multi-view memory/GPU cost**: N tabs ≈ N renderer processes; no authoritative
   per-view number exists (20 Gaps) — benchmark in M4 and pick `setVisible(false)` vs
   full detach/discard for background tabs (30 §9.4).
5. **Remote/web viewer requirement**: is watching an app-hosted session from a
   non-app (web) client required? Decides delete-vs-ISP-split of the presentation
   port half (§E) and whether `Page.startScreencast` survives inside the driver
   (30 §9.6). Default in this plan: not required ⇒ delete.
6. **Background-tab strategy**: `backgroundThrottling` default-on is right for
   inactive tabs; confirm nothing agent-driven needs a background tab's timers
   (20 §4).
7. **Permission UX**: deny-all is the safe initial policy (Electron auto-approves
   without a handler — 20 §3); a per-site prompt flow is deliberately out of scope
   until someone needs mic/camera.
8. **Device-emulation UX** on a visible view (R7): constrain to the existing device
   menu as an explicit visible mode; exact interaction design open (30 §9 / R7).
9. **DevTools coexistence** (R6): confirm the detach/re-attach dance and pick the
   human-DevTools story in M3/M4 (30 §9.5).
10. **Electron API verbatims**: 20 flags several THIN quotes (navigationHistory
    deprecation banner, `setBorderRadius` signature, `addChildView` index semantics,
    Electron 30→42 additions) — spot-check live docs before code comments cite them
    (20 Gaps).
11. **Tool-count discrepancy in the sources**: 10 says 16 tools, 30 says 17; the defs
    directory in this checkout has 16 tool files (+ `browser_shared.ts` helper). This
    plan standardizes on **16 tools + port-level ops** (§F).
