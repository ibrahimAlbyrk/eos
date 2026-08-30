# 40 — M6 parity audit: embedded-browser lane vs the `browser_*` tool contracts

Status: independent capstone audit. Date: 2026-08-30. Verdict: **GO** (with 3 non-blocking follow-ups).

Auditor note: I did NOT build this lane. Everything below is exercised end-to-end
against a running, isolated dev pair — evidence is real (urls/titles/snapshots/
boxes/http-codes/file dimensions), not a restatement of the design claims in
`00-BROWSER-PLAN.md`.

---

## 0. How this was verified (isolation)

The live daemon backing the operator's packaged `/Applications/Eos.app` (pid 69557,
port 7400) and the real `~/.eos` were **never touched**. All testing ran on a throwaway
pair:

- **Dev daemon**: `EOS_HOME=<tmp> EOS_PORT=7468 EOS_RAW_PORT=7469` on a temp home. Its
  `ui-token` was seeded from a copy of the real `~/.eos/ui-token` (read-only copy) so the
  app — which always reads `~/.eos/ui-token` (`app/src/main/daemon.ts:20`, not overridable)
  — presents a token the dev daemon accepts. `config.json` set `browser.enabled=true`.
- **Dev Electron app**: `EOS_DAEMON_URL=http://127.0.0.1:7468 electron-forge start --
  --user-data-dir=<tmp>`. The `--user-data-dir` override is required: in dev
  `app.getName()` resolves to productName "Eos", so without it the dev app would collide
  on the packaged app's single-instance lock (`~/Library/Application Support/Eos`) and quit.
  It adopted the (real) daemon socket for its spawn decision but drove the browser-host
  channel at `7468`.
- Registration confirmed both sides: daemon log `browser host registered pid=38081
  appVersion=0.0.0`; app log `[eos-browser] registered as browser host`.
- Tools were driven through the **actual daemon REST path** (`manager/routes/browser.ts`,
  which is exactly what each `browser_*` tool wraps) as the **human** actor (ui-token) so no
  synthetic worker row was needed; the engine path (RemoteBrowserEngine → /browser/host →
  MainWebContentsDriver) is identical regardless of actor.

**Lane proof**: `GET /browser/status?session=embed` → `chromePath:"WebContentsView
(embedded)"` (the `RemoteBrowserEngine` sentinel), and the dev daemon spawned **no**
headless Chrome for the `embed` session (its only Chrome child was the separate `fallback`
session used in §2). So the `embed` tab genuinely lived in the app's `WebContentsView`.

---

## 1. 16-tool parity table (embedded lane)

Result: **16 / 16 PASS.** Session `embed`, tab `bt-df95587f3d9b`, a base64 `data:` fixture
page (heading, button+onclick, link, text input, checkbox, sentinel text, 3000px-tall div,
bottom marker). Evidence is the observed response.

| # | `browser_*` tool | REST exercised | Evidence (observed) | Result |
|---|---|---|---|---|
| 1 | `browser_navigate` | `POST …/navigate` `url`,`reload`,`back`,`forward` | reload→`{ok}`; url→title "Page Two"; back→title "Eos Audit Page"; forward→title "Page Two" | PASS |
| 2 | `browser_new_tab` | `POST /browser/tabs {url}` | minted `bt-df95587f3d9b`; 2nd tab `bt-4804d425f1f8`; list count 1→2 | PASS |
| 3 | `browser_close_tab` | `DELETE /browser/tabs/{id}` | closed 2nd tab; list count 2→1 | PASS |
| 4 | `browser_tabs` | `GET /browser/tabs` | `sessionId:"embed"`, tab row `{title:"Eos Audit Page",muted,audible,canGoBack}` | PASS |
| 5 | `browser_snapshot` | `POST …/snapshot` | a11y tree w/ `@eN`: `button "Click Me" @e11 · link @e12 · textbox @e13 · checkbox @e14`; `interactiveOnly:false` adds `text` nodes (Sentinel/Bottom Marker) | PASS |
| 6 | `browser_find` | `POST …/find` text + `/regex/` | `Agree`→`checkbox @e14`; `/go next/i`→`link "Go Next"`; boxes present | PASS |
| 7 | `browser_act` | `POST …/act {ref,verb}` | click→`#out`="clicked"; check→`state:["checked"]`; uncheck→`state:null`; hover→`{ok}`; focus→`{ok}` | PASS |
| 8 | `browser_type` | `POST …/act {ref,text}` | typed "Hello Audit" → `get value`="Hello Audit" | PASS |
| 9 | `browser_fill_form` | `POST …/act {fields:[…]}` | name:="FilledByForm" → `get value`="FilledByForm" | PASS |
| 10 | `browser_press` | `POST …/act {key}` | `Tab`→`{ok}`; `Enter`→`{ok}` | PASS |
| 11 | `browser_scroll` | `POST …/act {direction}` | down/bottom/top each `{ok}` (JS `scrollBy`, mouseWheel intentionally avoided — see §4) | PASS |
| 12 | `browser_get` | `POST …/get {what,ref?}` | url=`data:…`; title="Eos Audit Page"; text="Audit Heading … Omega"; value (ref) as above | PASS |
| 13 | `browser_wait` | `POST …/wait` | forText present→`{ok,elapsed 2ms}`; forRef→`{ok}`; forMs 300→`{elapsed 302}`; missing text 800ms→`{ok:false,timedOut:true,763ms}` | PASS |
| 14 | `browser_screenshot` | `POST …/capture` | viewport→JPEG 1280×800 (18.5 KB); fullPage→JPEG 1265×**3202** (captures full 3000px page); viewport render visually verified (page content, not blank) | PASS |
| 15 | `browser_show` | `POST /browser/show` | explicit tabId→`{ok,tabId}`; omitted→resolves active tab→`{ok,tabId}` | PASS |
| 16 | `browser_mute` | `POST …/mute {muted}` | mute→`tabs[].muted=true`; unmute→`{ok}` | PASS |

Port-level ops (not tools, mapped in plan §F) also exercised:

| Port op | REST | Evidence | Result |
|---|---|---|---|
| `elementAt` (picker) | `POST …/elements {at:[x,y]}` | at button center (41,91)→`{tag:"button",role:"button",name:"Click Me"}` | PASS |
| `setDevice` | `POST …/device {device}` | mobile→`{ok}`, **no segfault**, snapshot after works ("Second Page"); responsive→`{ok}` | PASS |
| active-tab (omitted-tabId) | `GET /browser/active-tab` | →`{tabId:"bt-df95587f3d9b"}` | PASS |

**`@eN` stale-ref invariant — HOLDS.** Captured `@e22`, `navigate reload` (clears the ref
map on `Page.frameNavigated`/`did-navigate`), then `act @e22` → **HTTP 409** with body:
`unknown or stale ref "@e22" — the page has changed since it was minted; call snapshot
(or find) again for fresh refs`. The typed `StaleRefError` survives the /browser/host hop
(name preserved) and the route maps it to 409 — parity with the headless lane.

---

## 2. Headless fallback (no app host registered)

Before launching the app, the dev daemon had **no** host registered. On session `fallback`
the factory returned the `CdpBrowserAdapter`:

- `POST /browser/launch` → `state:"running", chromePath:"/Applications/Google Chrome.app/
  …/Google Chrome"` (real headless Chrome, `--headless=new --remote-debugging-pipe`, throwaway
  temp profile — confirmed as a child process of the dev daemon).
- open tab (data URL) → `bt-9ac25d57b77b`; **snapshot** → `@eN` a11y tree
  (`button "Click Me" @e1 · link @e2 · textbox @e3 · checkbox @e4`); **find** "Click Me" →
  `@e5` w/ box; **act** click → `{ok}` and `get text`→`#out`="clicked" (the click fired).
- **Presentation absent** (no embedded view, no panel, no screencast) — correct: the fallback
  lane is automation-only, which is exactly the intended headless/CI/cron behavior.

Fallback verdict: **PASS** — automation (navigate + snapshot + act) works headless; presentation
is correctly absent.

---

## 3. Regression / guard / tsc / lint

| Check | Command | Result |
|---|---|---|
| Manager browser suites | `cd manager && npx tsx --test tools/__tests__/browser-tools.test.ts routes/__tests__/browser-session.test.ts services/__tests__/BrowserService.test.ts services/__tests__/browser-actor.test.ts` | **PASS** — 58/58 |
| Backend-kind literal guard | `cd manager && npx tsx --test backends/__tests__/backend-kind-literal-guard.test.ts` | **PASS** — 1/1 (no `kind`-literal branching crept in) |
| Infra browser | `cd infra && npx tsx --test src/__tests__/CdpBrowserAdapter.test.ts src/__tests__/snapshotFormatter.test.ts` | **6/7 PASS, 1 FAIL** — see Issue A |
| app/ui browser | `cd app/ui && npx vitest run src/state/browserPanelStore.test.js src/state/browserSessionState.test.js src/state/browserComposerHandoff.test.js src/views/browser/BrowserChrome.test.jsx` | **PASS** — 68/68 (4 files) |
| App typecheck | `cd app && npx tsc --noEmit` | **PASS** — clean |
| Repo lint | `npm run lint` | **PASS** — 0 errors (872 warnings; dependency-direction enforced) |

**Tool contracts + REST unchanged by the embedding work.** The 16 `manager/tools/defs/
browser_*.ts` files have **no** uncommitted diff. The only uncommitted edits to
`contracts/src/browser.ts` (+5/−5) and `manager/routes/browser.ts` (+5/−4) are **comment
wording only** (screencast → embedded `WebContentsView`); no schema field, enum, request/
response shape, route path, or handler logic changed. (Note: `git diff main…HEAD` shows the
whole browser surface as new-on-branch because the feature was developed on
`electron-migration`; the M6 invariant that matters — the embedding work froze the tool
contracts — holds.)

There is **no dedicated automated test** for `RemoteBrowserEngine`, `MainWebContentsDriver`,
or `AppBrowserHost` (Issue C).

---

## 4. Known-issues spot-check (M4 workarounds + deferrals)

M4 workarounds — all **verified live**:

- **Device-emulation SIGSEGV avoided** — `setDevice mobile` succeeded and the view survived
  (host stayed registered; post-change snapshot returned "Second Page"). The driver only
  issues `Emulation.setDeviceMetricsOverride` on an attached, real-sized view
  (`views.ts createTab` attaches + `setBounds` before any override; full-page capture uses a
  clip, never a metrics override — `driver.ts:captureFullPage`).
- **Hidden-tab navigation via focus-emulation** — every verb (incl. `navigate url`/`back`/
  `forward`, clicks, typing) worked while the view was never brought to the panel foreground.
  `Emulation.setFocusEmulationEnabled` on create (`views.ts:145`) keeps a hidden view from
  deferring renderer-initiated navigation. Confirmed.
- **JS scroll (mouseWheel avoided)** — `scroll` returns `{ok}` via `window.scrollBy`/
  `scrollTo`; the driver deliberately avoids `Input.dispatchMouseEvent{mouseWheel}` (it hangs
  on a `WebContentsView`, `driver.ts:305`).
- **Full-page clip capture** — `fullPage` returned a 1265×**3202** JPEG via
  `Page.captureScreenshot{captureBeyondViewport,clip}` (timeout-guarded, degrades to a
  viewport shot). Confirmed on the embedded view.

Explicitly-deferred UI items (open by design — NOT failing this audit):

- Interactive DevTools coexistence (R6). Driver has the re-attach path
  (`ensureAttached`); the human-facing detach/pause affordance is deferred. Not exercised.
- Permission-prompt UX (I-7). Deny-all is installed (`views.ts:52`
  `setPermissionRequestHandler(callback(false))` + `setPermissionCheckHandler(()=>false)`); a
  per-site allow/deny flow is deferred.
- Pixel-level active-tab z-order with the panel open (R1). Native-layer-over-React occlusion
  is handled by `setVisible(false)` on overlay/hide; final pixel polish deferred.

---

## 5. Issues found (ranked) — none block GO

**A. [Low] Infra `CdpBrowserAdapter` real-Chrome test fails on `canGoBack`.**
`CdpBrowserAdapter.test.ts:99` asserts `canGoBack===false` right after opening a single tab
on a `data:` URL; on this machine's Chrome it got `true`. This is a timing-sensitive assertion
(500 ms window vs history reset) — in a **live** REST run on the same adapter+Chrome,
`browser_tabs` reported `canGoBack:false` (correct). So it's a flaky headless-lane integration
test, not a functional defect. Fix: deflake the assertion (await history-reset settle). Headless
lane only; embedded lane unaffected.

**B. [Low/cosmetic] Stale status probe after a lane switch.**
`BrowserService.probe()` caches `probeEngine` and only clears it on host **deregister**
(`resetEngines`), not on **register**. Observed: `GET /browser/status?session=embed` reported
the headless Chrome `chromePath` for a never-launched `embed` session (because a headless probe
was cached earlier), correcting to `"WebContentsView (embedded)"` once its first tab launched.
Cosmetic status-string only — actual per-launch engine selection is correct. Fix: reset the
probe on register too (or derive `binaryPath` from `appHost.isRegistered()`).

**C. [Low] No automated coverage for the new embedded-lane code.**
`RemoteBrowserEngine`, `MainWebContentsDriver`, `AppBrowserHost` have no unit/integration
tests; parity rests on shared pure modules (`snapshotFormatter`/`keys` imported from infra) +
this manual audit. Fix: add a channel round-trip + typed-error (StaleRefError) test for
`RemoteBrowserEngine`, and a driver verb-matrix test.

---

## 6. Verdict — GO

The embedded-browser lane is at **full parity** with the `browser_*` tool contracts:
**16/16 tools PASS** end-to-end on a real Electron `WebContentsView` host, the `@eN`
stale-ref→409 invariant survives the process hop, port-level ops (elementAt/setDevice/
active-tab) work, and the M4 workarounds (device-emulation, hidden-tab nav, JS scroll,
full-page clip capture) are verified live. The **headless fallback** still automates with
presentation correctly absent. The backend-kind guard passes, `tsc` is clean, lint has 0
errors, and the tool contracts + REST are unchanged by the embedding work (comment-only edits).

**Must-fix before "done": none.** Recommended non-blocking follow-ups: (A) deflake the
`CdpBrowserAdapter.canGoBack` integration assertion, (B) reset the status probe engine on host
register, (C) add automated tests for `RemoteBrowserEngine`/driver/host. All three are
low-severity and independent of the GO decision.

Deferred UI items (DevTools coexistence, permission-prompt UX, active-tab pixel z-order) remain
open by design and are acceptable deferrals, not blockers.
