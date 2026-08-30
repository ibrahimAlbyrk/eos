# 30 — Keeping the agent driving the browser after it becomes an embedded `WebContentsView`

Status: findings / design proposal. No code changed.
Date: 2026-08-30. Electron `42.10.1` (`app/package.json`).
Scope: how the existing `browser_*` MCP automation survives when the shared browser
stops being an out-of-process headless Chrome and becomes a real, embedded Electron
`WebContentsView` that the human also drives directly — one browser, two drivers.

External claims are quoted with their URL and the access date `2026-08-30`. Repo
references are `path:line`.

---

## 0. Headline (read this first)

The automation stack is already built around the right seam: a **`BrowserEngine`
port** (`core/src/ports/BrowserEngine.ts:100`) that the `browser_*` tools reach only
through `BrowserService` (`manager/services/BrowserService.ts:149`), and a **single
factory line** where the concrete driver is chosen
(`manager/container.ts:624` — `engineFactory: (sessionKey) => new CdpBrowserAdapter(...)`).
The tools never touch a browser directly; they POST to daemon routes
(`manager/tools/defs/browser_act.ts:18`, `manager/routes/browser.ts:91`) which call the
service which calls the port.

So the answer is **not** "rewrite the tools." It is: **add a second adapter behind the
same port** and select it at that one factory line.

Recommended architecture — **browser in the Electron main process, daemon drives it
over a control channel, proxied AT THE PORT (not at raw CDP)**:

- The real `WebContentsView` lives in the **Electron main process** (it must — a
  `WebContentsView` is a main-process object). The **human uses it natively**; the
  screencast/JPEG pipeline is no longer on the human's path.
- The daemon keeps `BrowserService` and the `browser_*` tools **unchanged**. Its
  `engineFactory` returns a new `RemoteBrowserEngine` — a `BrowserEngine`
  implementation that **RPCs each port method** over a daemon↔app control channel to a
  `MainWebContentsDriver` running in the app.
- `MainWebContentsDriver` in the app runs the **same automation logic** we already have
  (the pure ref/format code in `infra/src/browser/snapshotFormatter.ts` and
  `keys.ts`, and the CDP verb sequencing currently in `CdpBrowserAdapter`), pointed at
  **`webContents.debugger`** instead of a spawned Chrome's `--remote-debugging-pipe`.
- **Headless fallback stays**: when no app host is registered (a `eos start` daemon,
  cron, CI), `engineFactory` returns today's `CdpBrowserAdapter`. Same port, two
  adapters, chosen at runtime — textbook DIP/OCP.

Why proxy at the **port** and not at raw CDP: one `browser_act` is ~5 sequential CDP
round trips (`DOM.resolveNode` → `DOM.getBoxModel` → three `Input.dispatch*`, see
`CdpBrowserAdapter.ts:963-977`). Proxying at CDP makes every one of those a
cross-process hop; proxying at the port collapses the whole verb into **one** hop.

Why not "keep it daemon-side and just show frames in the app" (the status-quo
transport): that is still a JPEG video of a *separate* Chrome with *synthetic* human
input — it does not deliver "one real browser the human drives natively," which is the
whole point of embedding a `WebContentsView`. It is the cheapest option and a valid
interim step, but it is not the target.

---

## 1. What must be preserved (the contract that cannot move)

The agent-facing surface is 17 tools (`manager/tools/defs/browser_*.ts`). Their
contracts must not change — agents, prompts, and the permission gateway all bind to
them. Each is a thin HTTP shim; the real work is in the port. The operations that must
survive, and where each lives today:

| `browser_*` tool | Service method | Port method | Today's CDP / engine primitive |
|---|---|---|---|
| `browser_navigate` | `navigate` (`BrowserService.ts:283`) | `navigate` (`BrowserEngine.ts:114`) | `Page.navigate` / `Page.reload` / `Page.getNavigationHistory`+`navigateToHistoryEntry` (`CdpBrowserAdapter.ts:366`) |
| `browser_new_tab` | `openTab` (`:215`) | `openTab` (`:105`) | `Target.createTarget`+`attachToTarget`; `Page/DOM/Accessibility.enable`; audio guard via `Page.addScriptToEvaluateOnNewDocument`; `Emulation.setDeviceMetricsOverride` (`CdpBrowserAdapter.ts:289`) |
| `browser_close_tab` | `closeTab` (`:227`) | `closeTab` (`:106`) | `Target.closeTarget` (`CdpBrowserAdapter.ts:330`) |
| `browser_tabs` | `listTabs` (`:238`) | `listTabs` (`:107`) | `Target.getTargetInfo` + `Page.getNavigationHistory` + audible probe (`CdpBrowserAdapter.ts:341`) |
| `browser_snapshot` | `snapshot` (`:298`) | `snapshot` (`:127`) | `Accessibility.getFullAXTree` → `formatAXTree` (`CdpBrowserAdapter.ts:500`, `snapshotFormatter.ts:107`) |
| `browser_find` | `find` (`:308`) | `find` (`:128`) | `Accessibility.getFullAXTree` + role filter (`CdpBrowserAdapter.ts:523`) |
| `browser_act` (click/hover/focus/check/uncheck) | `act` (`:315`) | `act` (`:129`) | `DOM.focus` / `Runtime.callFunctionOn` / `DOM.getBoxModel` + **trusted** `Input.dispatchMouseEvent` (`CdpBrowserAdapter.ts:547`, `:971`) |
| `browser_type` | `typeText` (`:321`) | `typeText` (`:130`) | `DOM.focus` + `Input.insertText` (`CdpBrowserAdapter.ts:568`) |
| `browser_fill_form` | `fillForm` (`:327`) | (loops `typeText`) | as above |
| `browser_press` | `press` (`:336`) | `press` (`:131`) | `Input.dispatchKeyEvent` via `parseChord` (`CdpBrowserAdapter.ts:585`, `keys.ts:38`) |
| `browser_scroll` | `scroll` (`:342`) | `scroll` (`:132`) | `Runtime.evaluate` / trusted `Input.dispatchMouseEvent` wheel (`CdpBrowserAdapter.ts:600`) |
| `browser_get` | `get` (`:348`) | `get` (`:133`) | `Target.getTargetInfo` / `Runtime.evaluate` / `Runtime.callFunctionOn` (`CdpBrowserAdapter.ts:626`) |
| `browser_screenshot` | `capture` (`:355`) | `capture` (`:135`) | `Page.captureScreenshot` (+ tiled stitch for full page) (`CdpBrowserAdapter.ts:659`) |
| `browser_wait` | `wait` (`:379`) | `textPresent`/`refVisible` (`:139`) | `Runtime.evaluate` / `DOM.getBoxModel` (`CdpBrowserAdapter.ts:827`,`:833`) |
| `browser_show` | `setActiveTab` (`:263`) | (service-level) | brings the session's tab to front / rate-limited present (`routes/browser.ts:188`) |
| `browser_mute` | `setMuted` (`:403`) | `setMuted` (`:146`) | audio-guard re-inject (`CdpBrowserAdapter.ts:846`) |
| (element picker) | `elementAt` (`:372`) | `elementAt` (`:137`) | `DOM.getNodeForLocation` + `Accessibility.getPartialAXTree` (`CdpBrowserAdapter.ts:773`) |
| (device emulation) | `setDevice` (`:364`) | `setDevice` (`:136`) | `Emulation.setDeviceMetricsOverride`/`setUserAgentOverride` + reload (`CdpBrowserAdapter.ts:741`) |
| (live frames, human) | `subscribeFrames` (`:416`) | `startScreencast` (`:115`) | `Page.startScreencast` → JPEG WS (`CdpBrowserAdapter.ts:387`, `browser-ws.ts`) |
| (human input) | `input` (`:491`) | `dispatchInput` (`:122`) | `Input.dispatchMouseEvent`/`dispatchKeyEvent`/`insertText` (`CdpBrowserAdapter.ts:456`) |

The **load-bearing invariant** across all of it: `@eN` refs. A snapshot mints `@eN →
backendDOMNodeId` per tab; the map is cleared on every main-frame navigation; a stale
ref raises `StaleRefError` instead of clicking a recycled node
(`CdpBrowserAdapter.ts:6-11`, `:259-270`, `:932-940`; `BrowserEngine.ts:98`). This
logic is pure and portable — it must move with the adapter, unchanged.

---

## 2. The central problem

The daemon (Node) runs the agent, the MCP tools, and today the `CdpBrowserAdapter`.
The Electron **main** process is a *different* process that the app spawns
(`app/src/main/daemon.ts:178 spawnDaemon`, `app/src/main/index.ts:206`) — or, on the
adopt path, an already-running daemon the app did not spawn
(`app/src/main/index.ts:183`). A `WebContentsView` is a main-process object
(WebContentsView "running in the Main process only" —
https://www.electronjs.org/docs/latest/api/web-contents-view, 2026-08-30). So:

> the agent lives in the daemon process; the real view it must drive lives in the app
> main process. Something has to cross that boundary.

Two things cross today already, in the *opposite* direction (app → daemon): the app is
an HTTP/SSE/WS **client** of the daemon (`app/src/main/index.ts:272` SSE; the browser
frame WS `manager/browser-ws.ts`). The daemon is the server on loopback + a unix socket
(`CLAUDE.md` control-plane note). That existing client relationship is the backbone the
control channel should reuse.

---

## 3. Options and their SOLID trade-offs

### Option A — browser stays daemon-side (status-quo transport), rendered in the app

Keep `CdpBrowserAdapter` + headless Chrome exactly as-is; the Electron app shows the
screencast frames (as the web panel does now) inside a native surface, and forwards the
human's clicks back as CDP input over the frame WS (`browser-ws.ts:213`).

- **SRP/DIP**: perfect — nothing moves; the port, adapter, refs, tests all stand.
- **Cost**: this is *not a real embedded browser*. The human still watches a JPEG
  video of a **separate** Chrome and interacts through **synthetic** CDP input
  (`sendInputEvent`/`Input.dispatch*`). No native scrolling/IME/GPU video decode; two
  browser engines resident; the entire screencast + backpressure + watchdog machinery
  (`browser-ws.ts:66`, `BrowserService.ts:559`) stays on the hot path.
- **Verdict**: cheapest, lowest-risk, and a fine *interim* while the control channel is
  built — but it does not meet the goal "human + agent share one real browser."

### Option B — browser moves into the Electron main process; daemon gets a control channel

The real `WebContentsView` is owned by the app; the human drives it natively; the
daemon drives it remotely. Two sub-variants differ only in **where the seam sits**:

- **B1 — CDP-over-IPC (thin transport swap).** Keep the whole `CdpBrowserAdapter` in
  the daemon; replace only its transport (`CdpPipeClient`, `cdpPipe.ts`) with one that
  forwards `sendCommand(method, params, sessionId)` over the channel to
  `webContents.debugger.sendCommand`. Attractive because `CdpPipeClient.send`
  (`cdpPipe.ts:34`) and `webContents.debugger.sendCommand` have nearly the same shape.
  - **DIP**: excellent — logic stays in `infra`, the layering is untouched.
  - **Cost**: *chatty*. Every CDP primitive becomes a cross-process round trip; a
    single `act` is ~5 hops (`CdpBrowserAdapter.ts:963-977`). Worse, the adapter assumes
    **one** CDP connection multiplexing N targets by `sessionId`
    (`CdpBrowserAdapter.ts:166`,`:284`), but in Electron each tab is a separate
    `webContents` with its **own** `debugger` — there is no single connection to
    multiplex. Reconciling that inside the adapter is real surgery.

- **B2 — port-over-IPC (proxy at the `BrowserEngine` boundary).** The control channel
  carries **port methods** (`snapshot`, `act`, `typeText`, …), not raw CDP. The daemon
  holds a `RemoteBrowserEngine implements BrowserEngine` that RPCs each method to the
  app; the app runs the real adapter (`ElectronWebContentsDriver`) against
  `webContents.debugger`.
  - **DIP/OCP**: proxying at the port is the boundary the code was *designed* for —
    `engineFactory: (sessionKey) => BrowserEngine` (`BrowserService.ts:150`,
    `container.ts:624`). `BrowserService` and the tools do not change one line.
  - **SRP**: one RPC per verb (snapshot = 1 hop, act = 1 hop). The per-tab = per-
    `webContents` model is natural — no `sessionId`-multiplexing to unwind.
  - **Cost**: the automation logic (ref map, `formatAXTree`, verb sequencing) now runs
    in the **app** package. Mitigate by keeping the *pure* pieces
    (`snapshotFormatter.ts`, `keys.ts`) in `infra` and importing them from both the app
    driver and the headless adapter — no logic is duplicated, only re-hosted.

**Pick: B2 (port-over-IPC), with dual adapters behind the one factory and a headless
fallback.** It honors the existing port, minimizes round trips, matches the
per-`webContents` reality, and keeps the tool contracts frozen. Option A is the
fallback/interim; B1 is rejected on chattiness + the `sessionId` mismatch.

---

## 4. (a) Driving a `WebContentsView`'s `webContents` for every op

A `WebContentsView` exposes a `webContents` ("A WebContents property containing a
reference to the displayed WebContents" —
https://www.electronjs.org/docs/latest/api/web-contents-view, 2026-08-30). Two ways to
drive it, and the design uses **both**:

**(i) Native `webContents` methods** — best for coarse navigation/lifecycle/audio:
- Navigation: `loadURL(url, options)` returns `Promise<void>`; `reload()`. Note
  `goBack`/`goForward`/`canGoBack` are **deprecated** in favor of the
  `navigationHistory` API ("use `contents.navigationHistory` instead" /
  goBack/goForward/canGoBack/canGoForward "are marked Deprecated" —
  https://www.electronjs.org/docs/latest/api/web-contents, 2026-08-30). So the
  `navigate` back/forward branch (`CdpBrowserAdapter.ts:378`) maps to
  `webContents.navigationHistory.goToIndex(...)` / `.goBack()`.
- Screenshot: `capturePage([rect, opts])` → `Promise<NativeImage>`, with a `stayHidden`
  option ("Keep the page hidden instead of visible. Default is `false`." —
  web-contents, 2026-08-30). Good for the **viewport** shot; but `capturePage` only
  captures the visible view, so **full-page** capture
  (`CdpBrowserAdapter.ts:685` tiled stitch) must **stay on CDP**
  `Page.captureScreenshot` with `captureBeyondViewport`.
- Audio: `setAudioMuted(muted)` and `isCurrentlyAudible()` ("Returns boolean - Whether
  audio is currently playing." — web-contents, 2026-08-30). This **replaces** the whole
  injected audio-guard mute machinery (`CdpBrowserAdapter.ts:846-871`, `audioGuard.ts`)
  with a one-liner — a real simplification.
- Find-in-page: `findInPage(text, options)` + `stopFindInPage(action)` (web-contents,
  2026-08-30) — a native primitive the current toolset doesn't even have; can back a
  future `browser_find`-in-page if wanted.
- Reads: `executeJavaScript(code, userGesture)` → `Promise<any>` covers `get`/`wait`
  text probes exactly like `Runtime.evaluate` does today.

**(ii) CDP via `webContents.debugger`** — required for everything native methods don't
cover: the accessibility tree (`Accessibility.getFullAXTree`), `backendNodeId`
resolution (`DOM.*`), trusted input (`Input.dispatch*`), device emulation
(`Emulation.*`). See §5.

Mapping every port method to its in-app implementation:

| Port method | In-app `WebContentsView` implementation |
|---|---|
| `openTab` | `new WebContentsView({ webPreferences })`; `win.contentView.addChildView(view)`; `debugger.attach('1.3')`; `sendCommand('Page.enable'|'DOM.enable'|'Accessibility.enable')`; `loadURL` |
| `closeTab` | `win.contentView.removeChildView(view)` + `view.webContents.close()` |
| `listTabs` | per-view `webContents.getURL()`/`getTitle()`, `navigationHistory.canGoBack/Forward`, `isCurrentlyAudible()` |
| `navigate` | `loadURL` / `reload` / `navigationHistory.goToIndex` |
| `snapshot` / `find` | CDP `Accessibility.getFullAXTree` via `debugger`, then the **unchanged** `formatAXTree` (`snapshotFormatter.ts`) |
| `act` / `typeText` / `press` / `scroll` | CDP `DOM.focus`, `DOM.getBoxModel`, `Runtime.callFunctionOn`, and **trusted** `Input.dispatch*` via `debugger` (identical sequences to `CdpBrowserAdapter`) |
| `get` | `webContents.executeJavaScript` (or CDP `Runtime.evaluate` for ref-scoped reads) |
| `capture` | `webContents.capturePage()` for viewport; CDP `Page.captureScreenshot`+stitch for full page |
| `setDevice` | CDP `Emulation.setDeviceMetricsOverride`/`setUserAgentOverride` + reload (see §6 caveat: this resizes a *real* view) |
| `setMuted` | `webContents.setAudioMuted(true)` (native; drop the audio guard) |
| `elementAt` | CDP `DOM.getNodeForLocation` + `Accessibility.getPartialAXTree` |
| `startScreencast`/`dispatchInput` | **removed from the human path** — the human uses the native view. Retain a CDP-screencast implementation only if a remote/web viewer must see this session (see §7). |

---

## 5. (b) CDP over an Electron `webContents` — repointing the existing logic

The daemon already speaks raw CDP through a ~50-line transport
(`cdpPipe.ts`): `send(method, params, sessionId) → Promise` plus `on(method, listener)`
(`cdpPipe.ts:34`,`:49`). Electron's `webContents.debugger` is the **same protocol
through a different door**:

- `debugger.attach([protocolVersion])`, `debugger.sendCommand(method[, commandParams,
  sessionId])` returning a Promise, and a `message` event carrying `(event, method,
  params, sessionId)` where `sessionId` "will match the value sent from
  `debugger.sendCommand`" (https://www.electronjs.org/docs/latest/api/debugger,
  2026-08-30). That is the exact `send`/`on` shape `CdpBrowserAdapter` consumes.
- Because the target is a Chromium `webContents`, the **CDP domains the adapter uses are
  Chromium-level and available**: `Accessibility`, `DOM`, `Runtime`, `Input`, `Page`,
  `Emulation`, `Target`. The verb bodies in `CdpBrowserAdapter.ts` therefore transplant
  essentially verbatim — only the object they call `sendCommand` on changes.
- The Electron example itself shows `debugger.attach('1.1')` then
  `sendCommand('Network.enable')` (debugger docs example, 2026-08-30), confirming the
  arbitrary-domain `sendCommand` path.

**Two differences that are real work, not hand-waving:**

1. **Connection topology.** The spawned-Chrome adapter has ONE pipe connection and
   addresses N tabs by CDP `sessionId` from `Target.attachToTarget … flatten:true`
   (`CdpBrowserAdapter.ts:284`,`:301`). In-app, each tab is its **own** `webContents`
   with its **own** `debugger` — the driver keys `tabId → { view, debugger }` and calls
   that view's `debugger.sendCommand` with **no** `sessionId`. (`sessionId` is still
   available for OOP iframes within a view, but the tab dimension is no longer a CDP
   session.) This is why B2 (port proxy) is cleaner than B1 (CDP proxy): the port has no
   notion of a CDP session to reconcile.

2. **Screencast is optional in-app.** `Page.startScreencast` exists on the debugger, but
   the human now sees the **native** composited view — no JPEG stream needed for them.
   The screencast/ack/backpressure/watchdog code (`browser-ws.ts`,
   `BrowserService.ts:416-583`) leaves the human hot path entirely. Keep it only for a
   remote viewer (§7).

**Caveat to design around (see §7 too):** the debugger and DevTools are mutually
exclusive on one `webContents` — the `detach` event fires "when the debugging session
is terminated. This happens either when `webContents` is closed or devtools is invoked
for the attached `webContents`" (https://docs.w3cub.com/electron/api/debugger.html,
2026-08-30; CDP allows a single client per target — cf. electron/electron#8336 "DevTools
connection failed when another debugger is already attached to this target",
https://github.com/electron/electron/issues/8336, 2026-08-30).

---

## 6. (c) Recommended architecture and the clean SOLID design

```
 ┌──────────────────────── daemon process (Node) ─────────────────────────┐
 │  browser_* tools ──HTTP──▶ routes/browser.ts ──▶ BrowserService         │
 │  (unchanged)                (unchanged)            (unchanged)           │
 │                                                        │ engineFactory   │
 │                                                        ▼                 │
 │                               RemoteBrowserEngine  implements BrowserEngine
 │                               (NEW: RPC proxy of the port)              │
 └───────────────────────────────────┬─────────────────────────────────────┘
                                      │  control channel (WS/IPC over loopback+uiToken)
                                      │  carries PORT methods + onTabsChanged/onExit events
 ┌───────────────────────────────────▼───────── Electron main process ─────┐
 │  MainWebContentsDriver  implements BrowserEngine                         │
 │    · owns WebContentsView per tab  · webContents.debugger per view       │
 │    · reuses snapshotFormatter.ts + keys.ts (pure, from infra)            │
 │  win.contentView.addChildView(view)   ← native composite, human drives   │
 └──────────────────────────────────────────────────────────────────────────┘

 Headless daemon (no app host registered):
   engineFactory ─▶ CdpBrowserAdapter (today) ─▶ spawned headless Chrome (unchanged)
```

**The port/adapter boundary (DIP).** `BrowserEngine` (`core`) is the abstraction; there
are two adapters:
- `CdpBrowserAdapter` (`infra`) — out-of-process headless Chrome. **Unchanged**, kept as
  the headless fallback.
- `MainWebContentsDriver` (**new, app-side**) — in-app `WebContentsView`.
The daemon never depends on either concretely; it depends on `BrowserEngine` and gets a
`RemoteBrowserEngine` proxy that forwards to whichever host is live.

**The one-line selection seam (OCP).** `container.ts:624` becomes:

```
engineFactory: (sessionKey) =>
  appHost.isRegistered()
    ? new RemoteBrowserEngine(appHost, sessionKey)   // in-app WebContentsView
    : new CdpBrowserAdapter({ ... })                 // headless fallback (today)
```

Nothing above the factory (service, routes, tools, tests) changes.

**Responsibility placement (SRP):**
- *Daemon* keeps policy and session identity: nav allowlist (agents only,
  `BrowserService.ts:593`), session fencing / dual-identity (`routes/browser.ts:69`),
  activity + timeline events (`routes/browser.ts:137`), header redaction
  (`BrowserService.ts:636`). None of that belongs in the app.
- *App* owns view lifecycle, native composite, `webContents.debugger`, and the CDP verb
  sequencing.
- *Pure logic* (`snapshotFormatter.ts`, `keys.ts`) stays in `infra` and is imported by
  both drivers — **DRY**, no duplication.

**The control channel.** Reuse the existing app→daemon client relationship: the app
opens a dedicated WS to the daemon (loopback + `uiToken`, exactly like the frame WS gate
`browser-ws.ts:117`) and **registers as the browser host**. The daemon's
`RemoteBrowserEngine` sends `{id, method, args}` frames; the app replies `{id, result}`
and pushes `onTabsChanged`/`onExit` notifications back (the port already exposes those
callbacks — `BrowserEngine.ts:152-153`). Direction matters for two reasons: (1) the
daemon may be **adopted** (app didn't spawn it) yet the app is always the connector
today; (2) `single-instance` lock (`index.ts:68`) guarantees **one** app host, so there
is never a fight over who owns the view.

**Why this keeps agents unchanged.** The agent calls `browser_act` exactly as before →
same HTTP route → same `BrowserService.act` → `engine.act(...)`. The only thing behind
`engine` that changed is a proxy that forwards to the app. The `@eN` ref contract, the
`StaleRefError` 409, the omitted-tabId "active tab" resolution
(`browser_shared.ts:11`, `routes/browser.ts:170`) — all identical.

---

## 7. (d) Human + agent sharing ONE real browser — risks and mitigations

This is where a real embedded view is genuinely harder than a screencast, because now
the human's input is native and concurrent, not synthetic.

**R1 — Native overlay z-order / clipping.** A `WebContentsView` is a native layer added
to `win.contentView` (`addChildView`, web-contents-view docs, 2026-08-30); it is **not**
a DOM element and does not clip to or scroll with the React UI — it floats above at the
rectangle you give `setBounds`. Mitigation: the app positions the view under the panel's
placeholder rect and calls `setVisible(false)` / `removeChildView` when the panel is
hidden, a tab switch occurs, or a modal must cover it. `browser_show`
(`routes/browser.ts:188`) becomes "bring this view to front + `win.show()/focus()`."
Track `setBounds`/visibility as app state that mirrors the daemon's per-session active
pointer (`BrowserService.activeBySession`, `:161`).

**R2 — Focus and who can inject without stealing it.** `webContents.sendInputEvent()`
requires focus: "The `BrowserWindow` containing the contents needs to be focused for
`sendInputEvent()` to work." (web-contents, 2026-08-30). That makes `sendInputEvent`
**unsuitable for the agent** — an agent action must not require the Eos window be
foreground, and must not yank focus from whatever the human is doing. The current
adapter already avoids this by using **CDP `Input.dispatch*`** (`CdpBrowserAdapter.ts:456`,
trusted click `:971`), which dispatches into the renderer independent of OS window
focus. **Keep CDP input for the agent**; let the human use the native view directly.
This cleanly separates the two drivers' input paths.

**R3 — Simultaneous input / interleaving.** Because both drivers reach the *same*
`webContents`, an agent click can land mid-way through the human's drag, or the agent can
type into a field the human just refocused. Mitigations: (1) reuse the existing
"an agent acted" signal — `browser:activity` `kind:"use"`/`"present"`
(`routes/browser.ts:137`) already drives a UI indicator; surface an explicit "agent is
driving" affordance while a verb is in flight. (2) Serialize per-tab verbs in the driver
(a per-`webContents` mutex) so agent ops don't interleave with each other. (3) Consider a
soft, advisory lock the human can always override — do **not** hard-block the human from
their own browser.

**R4 — Tab/target selection stays "the page the human sees."** Today omitted-tabId
resolves to the foreground tab the panel is viewing, with **no** first-tab fallback
(`browser_shared.ts:1-24`, `routes/browser.ts:170` → 409 "no active tab"). Preserve this:
the app reports which `WebContentsView` is currently shown to the daemon (updates
`setActiveTab`/`activeBySession`), so the agent's "this page" is exactly the human's
visible page. The safety property — refuse rather than guess — must not regress.

**R5 — Snapshot/ref sync when the human can navigate at any moment.** The agent snapshots
the DOM, then acts on `@eN` refs. If the human navigates (or an SPA route change fires)
between snapshot and act, the refs must not point at recycled nodes. This is *already*
solved: `Page.frameNavigated` on the main frame clears the tab's ref map, and any later
use of an old ref raises `StaleRefError` → 409 with a re-snapshot hint
(`CdpBrowserAdapter.ts:259-270`,`:932-940`; `routes/browser.ts:108`). In the shared model
this invariant matters **more**, not less — wire the in-app driver's ref-clear to the
same signal (CDP `Page.frameNavigated`, or the native `did-navigate` /
`did-navigate-in-page` events) so a human navigation invalidates the agent's stale refs
exactly as a programmatic one does today.

**R6 — Debugger ↔ DevTools exclusivity.** If the human opens DevTools on the embedded
view while the agent's `debugger` is attached (or vice versa), the session terminates
("devtools is invoked for the attached `webContents`" detaches — w3cub debugger,
2026-08-30; electron/electron#8336, 2026-08-30). Mitigations: keep the agent's
`debugger` attached for the view's lifetime and re-attach on the `detach` event; if the
human needs DevTools, either detach-on-demand and pause agent CDP ops, or point the
human at a *separate* DevTools target. At minimum, handle `detach` gracefully instead of
letting in-flight `sendCommand`s hang.

**R7 — Device emulation resizes a real, visible view.** `setDevice`
(`CdpBrowserAdapter.ts:741`) applies `Emulation.setDeviceMetricsOverride` + a reload.
Against a headless target that only affects the screencast; against a **visible**
`WebContentsView` it changes what the human sees (mobile viewport, reload). Decide the
UX: constrain agent device-emulation to a dedicated/hidden view, or make it an explicit,
visible mode the human sees change. Not a blocker, but a behavior change to design.

**R8 — Audio and "silence when unviewed."** Today audio plays to the system device and a
tab with no viewer is silenced via injected script (`BrowserService.silenceTab:655`,
`audioGuard.ts`). In-app, the real view plays audio natively; muting is
`webContents.setAudioMuted` and "silence when the panel is hidden" is just muting the
view when `setVisible(false)`. Simpler, but re-implement the intent (don't let a hidden
tab keep making noise) with the native API.

**R9 — Crash isolation.** A headless-Chrome crash cannot take down the app. An embedded
view's renderer crash is isolated by Chromium's multiprocess model, but the *view
lifecycle* is now app-owned — handle `render-process-gone` on each view and report it
back over the channel as an engine/tab error so the daemon surfaces it like today's
`onExit` (`BrowserEngine.ts:153`, `BrowserService.ts:680`).

---

## 8. Concrete change map

**Unchanged (contract-frozen):**
- All 17 `manager/tools/defs/browser_*.ts` and their prompts.
- `manager/routes/browser.ts`, `manager/services/BrowserService.ts` (policy, sessions,
  redaction, activity).
- `core/src/ports/BrowserEngine.ts` (the port) and `contracts/src/browser.ts`.
- `infra/src/browser/snapshotFormatter.ts`, `keys.ts` (pure — imported by both drivers).
- `infra/src/browser/CdpBrowserAdapter.ts` (kept as the headless fallback).

**New:**
- `RemoteBrowserEngine` (daemon) — `implements BrowserEngine`, RPCs each method over the
  channel; forwards `onTabsChanged`/`onExit`.
- `MainWebContentsDriver` (app, `app/src/main/…`) — `implements BrowserEngine` against
  `WebContentsView` + `webContents.debugger`, reusing the pure `infra` modules.
- A control-channel server on the daemon + a host-registration client in the app
  (reuse the loopback + `uiToken` gate from `browser-ws.ts:117`).

**One-line edit:** `manager/container.ts:624` — return `RemoteBrowserEngine` when an app
host is registered, else `CdpBrowserAdapter`.

---

## 9. Open questions / recommended spikes

1. **Round-trip latency** of port-over-IPC for the chatty verbs (`act`, `fill_form`)
   over the loopback WS — confirm it's imperceptible vs today's in-daemon CDP.
2. **`Accessibility.getFullAXTree` parity** via `webContents.debugger` on a *visible*
   view (verify identical node shape to headless, since `formatAXTree` depends on it).
3. **`Page.captureScreenshot` full-page** on an embedded view: does
   `captureBeyondViewport` + the tiled stitcher (`CdpBrowserAdapter.ts:685`) still work,
   or must full-page capture use a hidden clone?
4. **Multi-tab as multi-`WebContentsView`**: memory/GPU cost of N live views vs today's N
   targets in one Chrome; whether background tabs should be `setVisible(false)` vs fully
   detached.
5. **DevTools coexistence** (R6): confirm the detach/re-attach dance and pick the human
   DevTools story.
6. **Screencast retention** (§7): is a remote/web viewer of an app-hosted session a
   requirement? If yes, keep `Page.startScreencast` alive as a second output of the
   in-app driver; if no, delete the human-path screencast machinery.

---

## Sources (external, accessed 2026-08-30)

- WebContentsView API — https://www.electronjs.org/docs/latest/api/web-contents-view
- webContents API (`sendInputEvent` focus note, `capturePage`/`stayHidden`,
  `findInPage`, `setAudioMuted`/`isCurrentlyAudible`, `navigationHistory` deprecations) —
  https://www.electronjs.org/docs/latest/api/web-contents
- Debugger class (`attach`/`sendCommand`/`message`/`detach`, `sessionId`) —
  https://www.electronjs.org/docs/latest/api/debugger
- Debugger `detach` reason (DevTools invocation terminates the session) —
  https://docs.w3cub.com/electron/api/debugger.html
- Migrating from BrowserView to WebContentsView (constructor parity, `addChildView`,
  `setBounds` unchanged) — https://www.electronjs.org/blog/migrate-to-webcontentsview
- Single CDP client per target (DevTools vs attached debugger conflict) —
  electron/electron#8336, https://github.com/electron/electron/issues/8336
