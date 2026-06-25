# Menu-Bar Status Indicator — Architecture & Feasibility Design

Status: design only. No code written. Every claim below is grounded against the
current tree; file:line citations are given so a reviewer can check.

A native macOS `NSStatusItem` for the Eos app that:
- (a) shows an animated "running" state while ≥1 agent is busy,
- (b) announces completions, queued and played sequentially when several finish at once,
- (c) opens a popover listing agents on click,
- (d) focuses the Eos window at an agent when its row is clicked.

---

## 0. Feasibility verdict (one line)

**Feasible with the current architecture, no daemon/backend changes — the
cleanest seam is the SSE client that already exists in `app/main.swift`
(`connectSSE()` → `GET /stream`), extended to also reconcile `GET /workers`
into a status-item view-model.**

---

## 1. What was verified (grounding)

| Fact | Where |
|---|---|
| Native shell is one Swift file; `AppDelegate` is the single app owner | `app/main.swift:214`, bootstrap `app/main.swift:1163-1212` |
| Launch sequence: `setupNotifications()` → `setupWindow()` → `ensureDaemon()` | `app/main.swift:232-236` |
| A Swift SSE client **already exists** (URLSession streaming, line-buffered) | `connectSSE()` `app/main.swift:791`, parser `handleSSELine` `:805`, byte pump `urlSession(_:dataTask:didReceive:)` `:845` |
| It currently reacts to only one topic (`notification:fire`) | `app/main.swift:809-811` |
| Daemon base URL is a loopback constant | `DAEMON = "http://127.0.0.1:7400"` `app/main.swift:8` |
| SSE endpoint + worker list endpoint | `ROUTES.stream = "/stream"`, `ROUTES.workers = "/workers"` `contracts/src/http.ts:1638-1639` |
| SSE envelope is `event: change` / `data:{reason,ts,payload}` (one frame per bus topic) | `manager/sse/SseBroadcaster.ts:49-55` |
| Worker lifecycle states | `WorkerStateSchema` = SPAWNING·WORKING·IDLE·ENDING·DONE·KILLING·SUSPENDED `contracts/src/events.ts:18-29` |
| Canonical "busy/running" predicate already used server-side | `alive = state==="WORKING" \|\| state==="SPAWNING"` `manager/routes/workers.ts:107` |
| State transitions publish `worker:change` carrying **both** prev + next state | `{workerId, rowId, from, state}` `core/src/use-cases/TransitionState.ts:49` |
| Most other `worker:change` publishes are thin (`{workerId}` only) | e.g. `core/src/use-cases/LogEvent.ts:23`, `manager/routes/workers.ts:317,667` |
| `GET /workers` returns **all** rows incl. terminal DONE (no state filter) | `SqliteWorkerRepo.listAll` = `SELECT * FROM workers ORDER BY started_at DESC` `infra/src/persistence/SqliteWorkerRepo.ts:47`; route `manager/routes/workers.ts:157-161` |
| Worker row shape (id, state, name, is_orchestrator, parent_id, ended_at…) | `WorkerRowSchema` `contracts/src/worker.ts:17-114` |
| Web's live pattern: SSE is only a "change ping"; refetch `/workers` (80 ms debounce + 4 s poll) | `app/ui/src/hooks/useLive.js:1-7, 51-69, 138-141`; reconnect wrapper `app/ui/src/api/sse.js` |
| Deep-link/focus into the web UI already exists and is proven | `window.__nativeNavigate(id)` defined `app/ui/src/App.jsx:32`; used by the notification tap path `app/main.swift:761-770` |
| App is a **regular** activation app (no `LSUIElement`) — dock icon + main window | `app/Info.plist` (no `LSUIElement` key) |
| Closing the last window **quits the app today** | `applicationShouldTerminateAfterLastWindowClosed → true` `app/main.swift:841` |
| Build compiles a **single** source file | `swiftc … "$SCRIPT_DIR/main.swift"` `app/build.sh` (compile step) |

Net: the data plane (SSE + `/workers`), the focus mechanism (`__nativeNavigate`
+ `NSApp.activate` + `makeKeyAndOrderFront`), and an in-process SSE reader all
already exist. The feature is additive presentation + a small domain model on
top of seams that are already load-bearing.

---

## 2. Feasibility verdict + cleanest integration seam

**Verdict: yes, fully feasible, no backend change required.**

Why each leg already works:

- **Running animation (a)** — derivable from `GET /workers`: `running = workers
  .some(w => w.state==="WORKING" || w.state==="SPAWNING")`, the exact predicate
  the daemon uses (`manager/routes/workers.ts:107`).
- **Completion announcements (b)** — DONE rows persist in `/workers`
  (`SqliteWorkerRepo.ts:47`), so a **diff of two consecutive snapshots** yields
  the set of agents that went busy→terminal. No new event type, no payload
  change. The inline `from`/`state` on `worker:change`
  (`TransitionState.ts:49`) is a *latency optimization* (fire the refetch
  sooner), never the source of truth.
- **Popover (c)** — `GET /workers` already returns everything the list needs.
- **Focus (d)** — `window.__nativeNavigate(id)` + `NSApp.activate` +
  `makeKeyAndOrderFront` is the identical path the completion-notification tap
  already runs (`app/main.swift:761-770`). Reuse verbatim.

**Cleanest seam:** the existing `AppDelegate` SSE reader. Today
`handleSSELine` (`app/main.swift:805`) decodes each `data:` frame and acts only
on `reason == "notification:fire"`. The same decoded frame already carries
`reason ∈ {worker:change, worker:spawn, worker:exit, worker:removed}` with a
`payload.workerId`. We route those to a new status-bar subsystem that debounce-
refetches `/workers` and feeds a domain model — exactly mirroring `useLive`'s
proven SSE-ping→REST-refetch loop, but in Swift.

Recommended refinement: rather than bolt status-bar logic onto `AppDelegate`'s
SSE methods, introduce a dedicated SSE reader for the subsystem (or refactor the
existing one behind a small fan-out) so notifications and the status item are
independent consumers. See §7.

---

## 3. Where the `NSStatusItem` lives & how it is lifecycle-managed

**Owner:** a new `StatusBarCoordinator`, held by a strong `let` property on
`AppDelegate` (`app/main.swift:214`). `AppDelegate` is the process-lifetime
singleton (`app/main.swift:1163-1165`), so anything it strongly retains lives as
long as the app. This matches how `RemotePrefsWindowController` is owned today
(a long-lived top-level `let remotePrefs` at `app/main.swift:1155`).

**Creation point:** at the end of `applicationDidFinishLaunching`
(`app/main.swift:232`), after `setupWindow()`. The status item must be created
on the main thread (it is) and **retained** — an `NSStatusItem` whose owning
reference is dropped is removed from the menu bar. The coordinator holds it:

```
NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
```

**Lifecycle:**
- Created once at launch; never recreated on web reloads (unlike `loadWeb()`,
  which re-runs on every retry/update — the status item must not be coupled to
  webview reloads).
- The SSE subscription it depends on is started after launch and auto-reconnects
  with backoff, reusing the existing reconnect approach
  (`urlSession(_:task:didCompleteWithError:)` reconnect at `app/main.swift:856`,
  and the web's backoff policy in `app/ui/src/api/sse.js`).
- Torn down implicitly at process exit. No explicit teardown needed because the
  app process and the status item share a lifetime.

**Important coupling note (open question O-1, §8):** with
`applicationShouldTerminateAfterLastWindowClosed == true`
(`app/main.swift:841`), closing the Eos window **terminates the process**, which
also removes the status item. A persistent menu-bar indicator that outlives the
window requires flipping that to `false`. That is a product decision, flagged in
§8 — this doc does not assume it.

---

## 4. How the status item gets agent state (native SSE vs web bridge)

### Recommendation: **native Swift SSE + native `GET /workers` refetch.** Do not bridge from the web layer.

**Mechanism (mirrors `useLive`):**
1. Subscribe to `GET /stream` in Swift (the reader already exists,
   `app/main.swift:791`).
2. On a frame whose `reason` starts with `worker:` (`worker:change`,
   `worker:spawn`, `worker:exit`, `worker:removed`), schedule a **debounced**
   (~80–150 ms) `GET /workers` fetch — identical to `scheduleRefetch`
   (`useLive.js:51-69`).
3. Decode the array with the same shape as `WorkerRowSchema`
   (`contracts/src/worker.ts`). Only a few fields are needed: `id`, `state`,
   `name`, `is_orchestrator`, `parent_id`, `ended_at`.
4. Feed each fresh snapshot into the domain reducer (§5/§7), which derives the
   running flag and the completion events by diffing against the prior snapshot.
5. Poll `/workers` every ~4 s as a safety net (matches `POLL_MS` in
   `useLive.js:22`), in case an SSE frame is missed.

**Why native, not bridged from the web:**

| Dimension | Native Swift SSE (recommended) | Bridge from existing WKWebView |
|---|---|---|
| Independence from window | Works even if webview is mid-reload / not yet loaded; status item is never blank during `loadWeb()` churn | Status data dies whenever the page reloads (retry/update reloads happen, `app/main.swift:443`) |
| Existing infra | Reuses the SSE reader already in `AppDelegate` (`:791`) | Needs new `window.webkit.messageHandlers.*` plumbing + a JS producer in `app/ui` |
| Scope of change | Native only; **zero** web changes | Touches both layers; web must push deltas out via a new bridge message |
| Coupling | Status item ⟂ React app lifecycle | Couples a native chrome element to React mount/unmount + SSE inside the page |
| Failure modes | One more reader on a loopback stream the app already reads | Bridge silently stops if the page is navigated, errored, or backgrounded |
| Duplication | Re-implements a tiny ping→refetch loop (~40 lines, already a known pattern) | Avoids that duplication, but at the cost of cross-layer coupling |

The only real cost of native is duplicating the small ping→refetch loop. That
loop is ~40 lines and already battle-tested in `useLive.js`; duplicating it in
Swift is far cheaper than coupling a system-chrome element to the React app's
runtime. The web bridge is rejected.

**Payload trust:** treat every `worker:*` frame as an *invalidation hint only*
(the web does the same — see the `useLive.js` comment at `:1-3`). The thin
payloads (`{workerId}`) can't tell you *what* changed, and only
`TransitionState` enriches with `from`/`state`. So the authoritative state is
always the refetched `/workers` array, and completion detection is a snapshot
diff — never a trust of the inline `state` field.

---

## 5. Completion-queue state model

### Definitions

- **Busy set** `B = {SPAWNING, WORKING}` (canonical, `manager/routes/workers.ts:107`).
- **Completion** of agent `a`: across snapshots `S(t-1) → S(t)`,
  `a.state ∈ B` in `S(t-1)` and `a.state ∉ B` in `S(t)`.
  - Primary completion: → `DONE` (worker truly finished/ended).
  - Secondary (configurable): → `IDLE` (a turn finished, agent now awaiting
    input). The feature text says "finish"; whether IDLE counts is **open
    question O-2** (§8). Default recommendation: announce `→ DONE` as "✓ done";
    treat `→ IDLE` as off-by-default (it fires on every conversational turn and
    would be noisy).
- **Not a completion:** `worker:removed` (user killed it — `KillWorker.ts:128`)
  and an agent vanishing from the list (deleted). These dequeue/cancel any
  pending toast for that agent rather than announcing.

Detection is a **pure function** of two snapshots (testable, no AppKit, no time):

```
diff(prev, next) -> { running: Bool, completed: [AgentId] }
```

### Queue state machine

Three presentation phases plus a FIFO buffer:

```
        ┌─────────── completed=[] & running=false ──────────┐
        ▼                                                    │
     ┌──────┐   running=true    ┌──────────┐  completion(s)  │
     │ Idle │ ───────────────►  │ Running  │ ──────────────► enqueue
     │(icon)│ ◄───────────────  │(animated)│                 │
     └──────┘   running=false   └──────────┘                 │
        ▲            ▲                                        ▼
        │            │            ┌───────────────────────────────┐
        └────────────┴─────────── │ Announcing("✓ <name> done")   │
            queue drained         │ dwell ~2.5s, then advance      │
                                  └───────────────────────────────┘
```

- **Idle** — no busy agents, queue empty → static template icon.
- **Running** — ≥1 busy agent, queue empty → animated icon (§7 RunningAnimator).
- **Announcing** — queue non-empty → status button shows `✓ <name> done` for a
  fixed dwell, then pops the head and advances. The running animation may
  continue underneath / resume when the queue drains, depending on whether
  agents are still busy. Running and Announcing are *independent axes*: "still
  working" and "just finished X" can be true together.

### Debounce / coalesce rules

1. **Refetch debounce** — collapse a burst of `worker:*` frames into one
   `/workers` fetch (~80–150 ms), as `useLive.js:51-69` does. Several agents
   finishing within the same tick produce **one** snapshot diff that yields
   **multiple** completions enqueued together — exactly the "several at once →
   queue" requirement.
2. **Per-agent coalesce / dedup** — key pending completions by `agentId`. If the
   same agent appears again before its toast plays (rapid churn), keep only the
   latest; never enqueue two toasts for one agent in one drain cycle.
3. **Stale cancellation** — if agent `a` is queued (or mid-announce) and a later
   snapshot shows `a` back in `B` (it started a new turn) or `a` removed, drop
   `a`'s pending toast. A finished-then-immediately-restarted agent (queued
   message drain: IDLE→WORKING) must not announce a phantom completion.
4. **New completions mid-playback** — **append to the tail; never interrupt the
   current toast.** The current item always finishes its dwell. This is the
   "shown sequentially" guarantee.
5. **Overflow collapse** — if the queue exceeds N (e.g. 4), collapse the tail
   into one summary toast: `✓ X, Y +3 more`. Prevents a 20-agent fan-out from
   blocking the indicator for a minute.
6. **Cold start & reconnect reseed** — the first snapshot after launch, and the
   first snapshot after an SSE reconnect, establish a **baseline silently** (no
   diff-against-nothing flood). Otherwise reopening the app would announce every
   already-DONE worker, and a reconnect would replay missed completions as a
   storm. (Optional: on reconnect, a single coalesced "N finished while away"
   toast — deferred; default is silent reseed.)

### Why snapshot-diff, not event-trust

`GET /workers` keeps DONE rows (`SqliteWorkerRepo.ts:47`), so the transition is
observable as a state change in the list rather than a disappearance. Diffing is
deterministic, survives missed/duplicated SSE frames, and needs no payload
guarantees from the daemon. The inline `from`/`state` (`TransitionState.ts:49`)
only ever *triggers an earlier refetch*.

---

## 6. Click → popover → click-agent → focus

### Popover: **native AppKit `NSPopover`** (recommended), not a second web view.

| | Native `NSPopover` (recommended) | Embedded WKWebView popover |
|---|---|---|
| Weight | One lightweight list view | A 2nd `WKWebView` + its own `eos://` origin, SSE, and UI-token handshake (`app/main.swift:443-460`) |
| Latency | Instant show | Webview construct + page load before first paint |
| Styling parity | Must re-create a minimal row style in AppKit | Pixel-matches the dashboard |
| Data | Already have the `/workers` array natively | Would re-fetch/re-stream inside the popover |
| Token surface | None | Re-plumbs the per-boot UI token into a second surface |

The list is trivial (icon + name + state dot + elapsed). Re-creating that in
AppKit/SwiftUI is far cheaper than standing up a second web runtime with its own
origin and token. Native wins.

**Popover content:** an `NSPopover` anchored to the status item's button,
showing the agents from the latest snapshot — sorted (busy first, then by
`started_at`), labeled by `name` (fallback to short `id`), with `is_orchestrator`
distinguished, and a per-row state indicator. The same snapshot stream that
drives the icon drives the list, so it updates live while open.

### Focus / deep-link: **reuse the proven path verbatim.**

On row click the coordinator calls `AgentNavigator.focus(agentId)`, whose live
implementation runs the *exact* sequence the completion-notification tap already
uses (`app/main.swift:761-770`):

```
NSApp.activate(ignoringOtherApps: true)
window.makeKeyAndOrderFront(nil)
webView.evaluateJavaScript("window.__nativeNavigate?.('\(agentId)')")
```

`window.__nativeNavigate` (`app/ui/src/App.jsx:32`) sets the active view to
`code` and selects the agent. It already exists and is already the contract
between native chrome and the web app — no new bridge is introduced. The
popover closes after dispatch.

Edge: if the main window was closed (and the app is still alive — only possible
if O-1 is resolved to keep the app running), `makeKeyAndOrderFront` re-shows it;
if `window` was released, the navigator must guard for nil and recreate via
`setupWindow()`. This is tied to O-1 (§8).

---

## 7. Clean / SOLID module breakdown

Headline layering (one direction of dependency, AppKit only in the outer ring):

```
  [ SSE / REST ingestion ]  →  [ domain state model ]  →  [ presentation ]  →  [ interaction/nav ]
   AgentStatusSource           FleetReducer +              StatusItemController   AgentNavigator
   (protocol)                  CompletionQueue             + RunningAnimator       (protocol)
                               (pure, no AppKit)           + AgentPopover
                                          ▲                                            ▲
                                          └──────── StatusBarCoordinator (composition root) ┘
```

### Ports / protocols (the swap points)

```swift
// SOURCE port — DIP. The domain depends on this abstraction, not on URLSession.
protocol AgentStatusSource: AnyObject {
    var onSnapshot: (([AgentSnapshot]) -> Void)? { get set }   // full /workers refetch
    var onConnectivity: ((Bool) -> Void)? { get set }
    func start()
    func stop()
}

// NAVIGATION port — DIP. The popover depends on this, not on WKWebView/NSApp.
protocol AgentNavigator: AnyObject {
    func focus(agentId: String)
}

// PRESENTATION port — lets the queue drive any renderer (status button, tests).
protocol CompletionPresenter: AnyObject {
    func renderRunning(_ running: Bool)
    func announce(_ text: String)         // show one completion for its dwell
}
```

### Modules

1. **Ingestion — `SSEAgentStatusSource: AgentStatusSource`**
   - Owns the `GET /stream` subscription + debounced `GET /workers` refetch +
     4 s poll. Emits `[AgentSnapshot]` (id, state, name, isOrchestrator,
     parentId, endedAt). Knows HTTP/SSE; knows nothing about icons or queues.
   - **SRP:** turn the network into snapshots. **DIP:** exposed only as
     `AgentStatusSource`, so a `MockAgentStatusSource` feeds the domain in tests
     with zero networking. **OCP:** swapping transport (e.g. a future WS bridge)
     means a new conformer, no change to consumers.

2. **Domain — `FleetReducer` + `CompletionQueue` (pure, no AppKit/Foundation-time)**
   - `FleetReducer.diff(prev, next) -> (running: Bool, completed: [AgentId])`,
     plus name resolution. Pure function of two snapshots.
   - `CompletionQueue`: FIFO with the coalesce/dedup/stale-cancel/overflow rules
     (§5). Time is injected via a `Clock`/`Scheduler` port so dwell/debounce are
     testable without sleeping.
   - **SRP:** "what changed" + "what to play next", nothing else. **OCP:**
     announcement copy and overflow policy are strategies you extend, not
     edit. **DIP:** depends on a `Clock` abstraction, not wall-clock.

3. **Presentation — `StatusItemController` + `RunningAnimator` + `AgentPopover`**
   - `StatusItemController` owns the retained `NSStatusItem`, renders the
     running/announcing visual, hosts the popover. Conforms to
     `CompletionPresenter`.
   - `RunningAnimator`: drives the busy animation on a **template** image
     (`image.isTemplate = true`) so it auto-tints for light/dark menu bars
     (risk R-1). Start/stop only; no knowledge of *why* it's running.
   - `AgentPopover`: builds the `NSPopover` list from the latest snapshot; emits
     a row-click with an `agentId`.
   - **SRP:** each is one visual concern. **OCP:** the animator is replaceable
     (rotating SF Symbol vs frame-cycle) without touching the model.

4. **Interaction / Navigation — `WebViewAgentNavigator: AgentNavigator`**
   - Wraps the existing focus sequence (`NSApp.activate` +
     `makeKeyAndOrderFront` + `__nativeNavigate`, `app/main.swift:761-770`).
   - **SRP:** "bring agent X to the foreground." **DIP:** the popover calls the
     protocol; in tests a `SpyNavigator` records the id without driving AppKit.

5. **Composition root — `StatusBarCoordinator`**
   - The only place that knows all four rings. Wires
     `source.onSnapshot → reducer/queue → presenter`, and
     `popover row-click → navigator`. Held by `AppDelegate`.
   - **SRP:** wiring + ownership. Keeps `AppDelegate` from growing a fifth
     responsibility; everything testable is behind a port it injects.

This satisfies the brief's requested separation — *status source / event
ingestion → domain state model → view/presentation → interaction/navigation* —
with each boundary a named protocol so the source is swappable and every ring is
unit-testable headless.

---

## 8. Files / modules to add (and where)

All new Swift lives under a new `app/StatusBar/` group (the app is currently a
single file; grouping keeps SRP visible):

| File | Responsibility | Layer |
|---|---|---|
| `app/StatusBar/AgentStatusSource.swift` | `AgentStatusSource` protocol + `AgentSnapshot` value type + `SSEAgentStatusSource` (stream + debounced `/workers` refetch + poll) | Ingestion |
| `app/StatusBar/FleetModel.swift` | `FleetReducer.diff(...)`, `Clock` port, pure — no AppKit | Domain |
| `app/StatusBar/CompletionQueue.swift` | FIFO + coalesce/dedup/stale-cancel/overflow state machine (§5) | Domain |
| `app/StatusBar/StatusItemController.swift` | retained `NSStatusItem`, `CompletionPresenter`, `RunningAnimator` | Presentation |
| `app/StatusBar/AgentPopover.swift` | `NSPopover` + agent list view + row-click callback | Presentation |
| `app/StatusBar/AgentNavigator.swift` | `AgentNavigator` protocol + `WebViewAgentNavigator` | Navigation |
| `app/StatusBar/StatusBarCoordinator.swift` | composition root; wires the four rings | Composition |

**Edits required to integrate (described, not made — out of scope here):**

- `app/main.swift` — `AppDelegate` gains `private var statusBar: StatusBarCoordinator?`,
  constructed at the end of `applicationDidFinishLaunching` (`:232`) after
  `setupWindow()`. The `WebViewAgentNavigator` is handed the `window` + `webView`
  refs. Optionally, the existing `connectSSE`/`handleSSELine` (`:791`/`:805`) is
  refactored so notifications and the status item are two consumers of one reader
  (cleaner) — or the status source opens its own stream (simpler, one extra
  loopback reader). Recommend the latter for isolation.
- `app/build.sh` — **the build compiles only `main.swift`** (single-file
  `swiftc` invocation). Adding files means listing them in the compile step
  (e.g. `"$SCRIPT_DIR"/main.swift "$SCRIPT_DIR"/StatusBar/*.swift`). This is the
  one non-source build change the feature needs; without it the new files are
  never compiled. (Flagged because it's easy to miss given the single-file
  layout.)

No changes to `contracts/`, `manager/`, `core/`, `infra/`, or `app/ui/` are
required for the recommended (native) design.

---

## 9. Risks, edge cases, open questions

### Risks (R)

- **R-1 Light/dark menu bar.** Use a **template image**
  (`image.isTemplate = true`) for both idle and running states so AppKit tints
  it for the active menu-bar appearance automatically; never hardcode black/
  white. Announcement text uses the status button's default (system) label
  color. Validate against the macOS 26 "reduce transparency" / tinted menu bar.
- **R-2 App-not-running.** The status item is part of the Eos process — it only
  exists while Eos runs. With the current quit-on-window-close behavior
  (`app/main.swift:841`) the indicator disappears the moment the window closes.
  See O-1. A separate always-on agent is explicitly out of scope.
- **R-3 SSE/daemon down.** On disconnect (`didCompleteWithError`, `:856`) stop
  the animation and show a neutral/dim icon; reconnect with backoff (reuse the
  policy in `app/ui/src/api/sse.js`). Never animate "running" while
  disconnected — it would lie.
- **R-4 Many agents at once.** Running animation is binary (any busy), so it
  scales. The popover list must scroll. The completion queue must collapse
  beyond N (§5 rule 5) so a large fan-out can't monopolize the indicator.
- **R-5 Rapid churn.** Per-agent coalesce + stale-cancel (§5 rules 2–3) prevent
  a flapping agent (IDLE↔WORKING from queued-message drains) from emitting
  phantom or duplicate toasts.
- **R-6 Snapshot cost.** `GET /workers` on every coalesced ping is the same load
  the dashboard already generates; debounce + 4 s poll keep it bounded. No new
  endpoint, no per-event payload growth.
- **R-7 Cross-thread.** `NSStatusItem`/`NSPopover` are main-thread only. The
  existing SSE delegate already dispatches to `.main` (`delegateQueue: .main`,
  `app/main.swift:798`); keep all presentation on main.

### Edge cases

- Worker **killed** (`worker:removed`, `KillWorker.ts:128`) ≠ completed → cancel
  its pending toast, drop from list.
- Worker → **SUSPENDED** (daemon restart, resumable) — not a completion; treat as
  not-busy, no announcement.
- **Cold start**: silently seed baseline so already-DONE workers don't flood
  (§5 rule 6).
- **Reconnect**: silent reseed (default) or one coalesced summary (optional).
- Agent with **null `name`** (`WorkerRowSchema` allows null `:24`) → fall back to
  a short id in both toast and popover.

### Open questions (O) — *not guessed; raised for a human decision*

- **O-1 (blocking for "persistent" semantics):** Should the status item persist
  after the main window is closed? Today `applicationShouldTerminateAfterLast
  WindowClosed` returns `true` (`app/main.swift:841`), so closing the window
  **quits the app and removes the status item**. A persistent menu-bar indicator
  requires returning `false` (and deciding whether to keep the dock icon or go
  `LSUIElement`/accessory). This is a product decision with UX consequences;
  the design above works either way but the "always visible" promise depends on
  it.
- **O-2 What counts as "finish"?** `→ DONE` (worker ended) is unambiguous. But a
  worker also leaves the busy set on every `→ IDLE` (turn done, awaiting input).
  Announcing IDLE fires on every conversational turn (noisy); announcing only
  DONE may feel too sparse for long-running orchestrations. Recommend DONE-only
  by default, IDLE opt-in. Needs a product call. (States per
  `contracts/src/events.ts:18-29`.)
- **O-3 Which agents are "agents"?** Should orchestrators and nested sub-workers
  count toward the running indicator and the completion queue, or only
  top-level/worker rows? `GET /workers` returns all rows incl. `is_orchestrator`
  and `parent_id` (`SqliteWorkerRepo.listAll`, `contracts/src/worker.ts`). The
  `/orchestrators` route is separate. Decision affects counts and popover
  grouping. (Recommend: include all, group orchestrators vs workers in the
  popover — but confirm.)
- **O-4 Announcement vs system notification overlap.** Eos already raises a
  `UNUserNotification` on `notification:fire` (`app/main.swift:778-787`,
  `manager/routes/workers.ts:376`). Should the status-bar completion queue be a
  *separate* channel, or coordinate so a user isn't double-notified for the same
  completion? Needs a product call on de-duplication.
- **O-5 Popover live-refresh while open.** Confirm the desired behavior when an
  agent's state changes while the popover is open (live re-sort vs frozen
  snapshot). Design supports either; default recommendation is live update from
  the same snapshot stream.
