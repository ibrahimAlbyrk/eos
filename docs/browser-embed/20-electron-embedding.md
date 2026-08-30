# Embedding a real interactive browser in Electron 42 / Chromium 148

Research question: what is the best way to embed a REAL, interactive browser view
(real navigation, real rendering, ideally tabs) inside the Eos Electron app window,
coexisting with the existing sandboxed React renderer served from `eos://`
(contextIsolation:true, sandbox:true, nodeIntegration:false)?

All sources accessed 2026-08-30. Source tiers: PRIMARY = official Electron docs and
the official Electron blog (electronjs.org); SECONDARY = Electron's own X/Twitter
announcement and third-party blogs. Provenance caveat: quotes below were extracted
via automated page fetch; wording is faithful but exact punctuation should be
spot-checked against the live page before being pasted into shipping code comments.

---

## Load-bearing summary

- RECOMMENDATION: use `WebContentsView`. It is the modern, non-deprecated primitive
  (added in Electron 30, so fully present in Electron 42), it gives the most control
  because each view owns a real `webContents` like a `BrowserWindow` does, and it is
  the explicit replacement Electron names for the now-deprecated `BrowserView`. The
  `<webview>` tag is explicitly not recommended and disabled by default; a plain
  `<iframe>` cannot deliver a real multi-tab browser with per-tab sessions,
  downloads, and navigation control.
- TAB MODEL: one `WebContentsView` per tab. Each view is attached to the window's
  `contentView` via `addChildView`, sized with `setBounds`, and given its own
  `session` via a `partition` string (`persist:` = on-disk, no prefix = in-memory).
  Switching tabs = showing one view and hiding/detaching the others; z-order is
  controlled by child order (re-adding a view moves it to the top).
- SECURITY: browsed content runs in its own sandboxed renderer with
  `contextIsolation:true`, `nodeIntegration:false`, and NO preload that exposes app
  APIs, on a `partition` separate from the app's own session. Navigation is fenced
  with `will-navigate` and `setWindowOpenHandler`; device permissions
  (camera/mic/geo/notifications) are gated with `setPermissionRequestHandler` —
  which you MUST set, because Electron auto-approves everything otherwise.
- LAYOUT / Z-ORDER GOTCHA: a `WebContentsView` is a NATIVE Chromium view layered over
  the window, not a DOM node. You cannot render React HTML (menus, modals, dropdowns)
  on top of it in the normal DOM way; anything that must appear above the browser has
  to be either its own top-most native view or handled by hiding/resizing the browser
  view. Positioning it to track a React layout region requires Main↔Renderer
  coordination (the renderer measures the region, the main process calls `setBounds`).
- IPC OWNERSHIP: the React renderer must NOT touch `webContents`. The MAIN process
  owns all views; a narrow, allow-listed control API (navigate, newTab, closeTab,
  switchTab, back, forward, reload) is exposed through the preload via
  `contextBridge`, invoked over IPC.

---

## 1. The embedding primitive — WebContentsView vs BrowserView vs `<webview>`

### Recommendation: WebContentsView

`WebContentsView` is a main-process view that wraps a full `webContents`, giving the
same degree of control a `BrowserWindow` has over its page.

> "A View that displays a WebContents." … the class "extends `View`".
> — PRIMARY, https://www.electronjs.org/docs/latest/api/web-contents-view

> "A `WebContents` property containing a reference to the displayed `WebContents`.
> Use this to interact with the `WebContents`, for instance to load a URL."
> — PRIMARY, https://www.electronjs.org/docs/latest/api/web-contents-view

The official web-embeds guidance ranks it as the highest-control option:

> "`WebContentsView`s offer the greatest control over their contents, since they
> implement the `webContents` similarly to how `BrowserWindow` does it."
> — PRIMARY, https://www.electronjs.org/docs/latest/tutorial/web-embeds

It arrived in Electron 30 (Eos is on 42, so it is stable and present):

> "Electron 30 has shipped 🚢! In this release: ❗️Added WebContentsView & BaseWindow,
> deprecating BrowserViews"
> — SECONDARY (official Electron X account),
> https://x.com/electronjs/status/1782561705580703788

> "Electron is moving from `BrowserView` to `WebContentsView` to align with
> Chromium's UI framework, the Views API."
> — PRIMARY, https://www.electronjs.org/blog/migrate-to-webcontentsview

### BrowserView — deprecated, do not use

> "The `BrowserView` class is deprecated, and replaced by the new `WebContentsView`
> class."
> — PRIMARY, https://www.electronjs.org/docs/latest/api/browser-view

Third-party confirmation that BrowserView is now merely a compatibility shim (SECONDARY,
so treated as thin corroboration of the primary deprecation notice above):

> "BrowserView is now a shim over WebContentsView and the old implementation has been
> removed."
> — SECONDARY (search synthesis of Electron release notes / migration docs), via
> https://www.electronjs.org/blog/migrate-to-webcontentsview

### `<webview>` tag — explicitly discouraged, off by default

> "We currently recommend to not use the `webview` tag and to consider alternatives,
> like `iframe`, a `WebContentsView`, or an architecture that avoids embedded content
> altogether."
> — PRIMARY, https://www.electronjs.org/docs/latest/api/webview-tag

> "We do not recommend you to use WebViews, as this tag undergoes dramatic
> architectural changes that may affect stability of your application."
> — PRIMARY, https://www.electronjs.org/docs/latest/tutorial/web-embeds

> "By default the `webview` tag is disabled in Electron >= 5." … "You need to enable
> the tag by setting the `webviewTag` webPreferences option when constructing your
> `BrowserWindow`."
> — PRIMARY, https://www.electronjs.org/docs/latest/api/webview-tag

> "Unlike an `iframe`, the `webview` runs in a separate process than your app. It
> doesn't have the same permissions as your web page and all interactions between your
> app and embedded content will be asynchronous."
> — PRIMARY, https://www.electronjs.org/docs/latest/api/webview-tag

### `<iframe>` — recommended for simple embeds, insufficient for a real browser

> "Iframes in Electron behave like iframes in regular browsers." … "it is recommended
> to use the `sandbox` attribute and only allow the capabilities you want to support."
> — PRIMARY, https://www.electronjs.org/docs/latest/tutorial/web-embeds

Comparison verdict (API stability / isolation / performance / control):
- API stability: WebContentsView is the current, non-deprecated API; BrowserView is
  deprecated; `<webview>` is warned to undergo "dramatic architectural changes."
- Isolation: WebContentsView and `<webview>` both run content in a separate
  process/webContents; iframe shares the host page.
- Performance: `<webview>` "tends to be slightly slower" than iframe (PRIMARY,
  web-embeds); WebContentsView is a first-class Chromium view tied to the rendering
  pipeline (see §4).
- Control: WebContentsView "offer[s] the greatest control" (quoted above).

### How it attaches to a window

`WebContentsView` is composed onto a `BaseWindow` (or a `BrowserWindow`, which is a
`BaseWindow`) via its `contentView`:

> "BaseWindow provides a flexible way to compose multiple web views in a single
> window. For windows with only a single, full-size web view, the BrowserWindow class
> may be a simpler option."
> — PRIMARY, https://www.electronjs.org/docs/latest/api/base-window

> "A `View` property for the content view of the window."
> — PRIMARY (contentView), https://www.electronjs.org/docs/latest/api/base-window

Instantiation + attach + position pattern (create view → `contentView.addChildView` →
`setBounds`):

> "this.browserWindow.contentView.addChildView(this.tabBar);" … "this.webContentsView
> .setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height});"
> — PRIMARY, https://www.electronjs.org/blog/migrate-to-webcontentsview

Note it is a native view, not a DOM element — layering implications are in §4.

---

## 2. Real-browser UX

### Multiple tabs — one WebContentsView per tab

BaseWindow is designed to "compose multiple web views in a single window" (quoted
§1). The tab strip itself can be its own view (`addChildView(this.tabBar)` above), and
each browsable tab is a separate `WebContentsView`. Tab switching is implemented by
child-view ordering (see §4 z-order) plus `setBounds`/detach.

### Navigation + history

> "Loads the url in the window." — loadURL, PRIMARY,
> https://www.electronjs.org/docs/latest/api/web-contents

> "Reloads the current web page." — reload, PRIMARY,
> https://www.electronjs.org/docs/latest/api/web-contents

Back/forward have MOVED off `WebContents` onto `webContents.navigationHistory`
(`goBack`/`goForward` on WebContents are marked deprecated):

> "Whether the browser can go back to previous web page." — canGoBack(), PRIMARY,
> https://www.electronjs.org/docs/latest/api/navigation-history

> "Makes the browser go back a web page." — goBack(), PRIMARY,
> https://www.electronjs.org/docs/latest/api/navigation-history

> "Whether the browser can go forward to next web page." — canGoForward(), PRIMARY,
> https://www.electronjs.org/docs/latest/api/navigation-history

> "Makes the browser go forward a web page." — goForward(), PRIMARY,
> https://www.electronjs.org/docs/latest/api/navigation-history

(THIN: the docs page for navigationHistory does not itself state that these methods
"moved" from WebContents; that they are deprecated on WebContents is inferred from the
WebContents page marking goBack/goForward as Deprecated. Verify the exact deprecation
banner on the live WebContents page before relying on it in code comments.)

### Per-tab session / partition isolation, cookies, storage

> "Sets the session used by the page according to the session's partition string."
> — partition webPreference, PRIMARY,
> https://www.electronjs.org/docs/latest/api/structures/web-preferences

> "If `partition` starts with `persist:`, the page will use a persistent session
> available to all pages in the app with the same `partition`. if there is no
> `persist:` prefix, the page will use an in-memory session." … "If the `partition` is
> empty then default session of the app will be returned."
> — PRIMARY, https://www.electronjs.org/docs/latest/api/session

> "When there is an existing `Session` with the same `partition`, it will be returned;
> otherwise a new `Session` instance will be created with `options`."
> — PRIMARY (session.fromPartition), https://www.electronjs.org/docs/latest/api/session

Implication: give each tab (or each "browser profile") its own `partition` string to
isolate cookies/localStorage; use `persist:<id>` for durable browsing state, a
prefix-less string for private/ephemeral tabs.

### Downloads

> "Emitted when Electron is about to download `item` in `webContents`." — 'will-download'
> event on Session, PRIMARY, https://www.electronjs.org/docs/latest/api/session

> "Calling `event.preventDefault()` will cancel the download and `item` will not be
> available from next tick of the process."
> — PRIMARY, https://www.electronjs.org/docs/latest/api/session

### Find-in-page and zoom

> "Starts a request to find all matches for the text in the web page." — findInPage,
> PRIMARY, https://www.electronjs.org/docs/latest/api/web-contents

> "Changes the zoom factor to the specified factor." — setZoomFactor, PRIMARY,
> https://www.electronjs.org/docs/latest/api/web-contents

> "Changes the zoom level to the specified level." — setZoomLevel, PRIMARY,
> https://www.electronjs.org/docs/latest/api/web-contents

### Context menus

> "Emitted when there is a new context menu that needs to be handled." — 'context-menu'
> event, PRIMARY, https://www.electronjs.org/docs/latest/api/web-contents

The event params include `x`/`y` coordinates and `linkURL` (the link under the cursor),
so the main process can build a native `Menu` and pop it at the click location.

### Popups / new-window handling

> "Called before creating a window when a new window is requested by the renderer, e.g.
> by `window.open()`, a link with `target=\"_blank\"`, shift+clicking on a link, or
> submitting a form with `<form target=\"_blank\">`."
> — setWindowOpenHandler, PRIMARY,
> https://www.electronjs.org/docs/latest/api/web-contents

> "When set to `{ action: 'deny' }` cancels the creation of the new window." … "`{
> action: 'allow' }` will allow the new window to be created."
> — PRIMARY, https://www.electronjs.org/docs/latest/api/web-contents

For a real browser you typically return `{ action: 'deny' }` and instead open the
requested `url` as a new in-app tab (a new WebContentsView), so popups become tabs.

### Audio

> "Mute the audio on the current web page." — setAudioMuted, PRIMARY,
> https://www.electronjs.org/docs/latest/api/web-contents

---

## 3. Security posture

Browsed (untrusted) content must run isolated from the app.

> "Context Isolation is the default behavior in Electron since 12.0.0." — PRIMARY,
> https://www.electronjs.org/docs/latest/tutorial/security

> "It is paramount that you do not enable Node.js integration in any renderer that
> loads remote content." — PRIMARY,
> https://www.electronjs.org/docs/latest/tutorial/security

> "You should enable the sandbox in all renderers." — PRIMARY,
> https://www.electronjs.org/docs/latest/tutorial/security

Defaults confirm the safe baseline (so the browser view inherits the right posture
unless overridden):

> "Default is `true` since Electron 20." — sandbox, PRIMARY,
> https://www.electronjs.org/docs/latest/api/structures/web-preferences

> "Defaults to `true`." — contextIsolation, PRIMARY,
> https://www.electronjs.org/docs/latest/api/structures/web-preferences

> "Default is `false`." — nodeIntegration, PRIMARY,
> https://www.electronjs.org/docs/latest/api/structures/web-preferences

Partition isolation from the app's own `eos://` session: give the browser view a
distinct `partition` (see §2) so its cookies/storage never mix with the app session
(default session is used only when partition is empty — PRIMARY, session doc §2).

Navigation control:

> "If you know which pages your app might navigate to, check the URL in the event
> handler and only let navigation occur if it matches the URLs you're expecting."
> — will-navigate guidance, PRIMARY,
> https://www.electronjs.org/docs/latest/tutorial/security

> "Emitted when a user or the page wants to start navigation on the main frame."
> — 'will-navigate' event, PRIMARY,
> https://www.electronjs.org/docs/latest/api/web-contents

> "Emitted when a server side redirect occurs during navigation. For example a 302
> redirect." — 'will-redirect', PRIMARY,
> https://www.electronjs.org/docs/latest/api/web-contents

For a real browser you generally allow arbitrary navigation of the BROWSER view but
still fence the APP's own renderer (never let `eos://` navigate away). Use
`will-navigate`/`will-redirect` on the browser view for policy (block list / scheme
allow-list) as needed.

Permission requests (camera/mic/geolocation/notifications) — you MUST install a
handler, since the default is permissive:

> "By default, Electron will automatically approve all permission requests unless the
> developer has manually configured a custom handler." — PRIMARY,
> https://www.electronjs.org/docs/latest/tutorial/security

> "Sets the handler which can be used to respond to permission requests for the
> `session`. Calling `callback(true)` will allow the permission and `callback(false)`
> will reject it." — setPermissionRequestHandler, PRIMARY,
> https://www.electronjs.org/docs/latest/api/session

The handler receives `webContents`, a `permission` string, and the `callback` — so you
can prompt the user or apply per-partition policy before granting.

Transport:

> "Any resources not included with your application should be loaded using a secure
> protocol like `HTTPS`." — PRIMARY,
> https://www.electronjs.org/docs/latest/tutorial/security

---

## 4. Rendering / performance / layout

### Native layer, not a DOM node — the core z-order constraint

A `WebContentsView` is a native Chromium view composited over the window, so the React
DOM cannot draw on top of it. The docs frame this as a Main↔Renderer coordination
problem:

> "positioning them accurately with respect to DOM content requires coordination
> between the Main and Renderer processes." — PRIMARY,
> https://www.electronjs.org/docs/latest/tutorial/web-embeds

Consequence for Eos: any React chrome that must appear ABOVE the browser (dropdown
menus, modals, toasts, the command palette) will be OCCLUDED by the WebContentsView
if it overlaps the view's bounds. Mitigations:
- Reserve a dedicated rectangle for the browser and keep app chrome outside it;
  measure that rect in the renderer and send it to main to `setBounds`.
- When a modal/menu must overlay the browser area, temporarily hide or shrink the
  browser view (detach via `removeChildView` or move it off-screen / zero its bounds),
  or promote the overlay to its own top-most native view.

### Z-order / stacking between multiple views

> "If the same View is added to a parent which already contains it, it will be
> reordered such that it becomes the topmost view." — addChildView, PRIMARY,
> https://www.electronjs.org/docs/latest/api/view

> "Calling `addChildView` on an existing view reorders it to the top." — PRIMARY,
> https://www.electronjs.org/blog/migrate-to-webcontentsview

> "A `View[]` property representing the child views of this view." — children, PRIMARY,
> https://www.electronjs.org/docs/latest/api/view

> "If the view passed as a parameter is not a child of this view, this method is a
> no-op." — removeChildView, PRIMARY, https://www.electronjs.org/docs/latest/api/view

So tab switching / bringing a view forward is done by re-`addChildView`-ing it (moves
to top); hiding is done with `removeChildView` or by zeroing bounds.

### Resizing / positioning to track a React region

Use `setBounds` with the measured rectangle (pattern quoted in §1). Because bounds are
set from the main process, the renderer must report layout changes (resize observer /
window resize) over IPC so main can re-`setBounds`.

### Rounded corners / clipping

`View.setBorderRadius` exists but has a hit-testing caveat:

> "The area cutout of the view's border still captures clicks." — setBorderRadius,
> PRIMARY, https://www.electronjs.org/docs/latest/api/view

(THIN: the border-radius API surface returned only this caveat sentence from the fetch;
confirm the exact `setBorderRadius(radius)` signature on the live View page.)

### Background throttling

> "Whether to throttle animations and timers when the page becomes background." …
> "Defaults to `true`." — backgroundThrottling, PRIMARY,
> https://www.electronjs.org/docs/latest/api/structures/web-preferences

For inactive tabs, leaving throttling on (default) saves CPU; disable per-view only if
a background tab must keep running timers.

### Multi-tab memory

Each `WebContentsView` is a full `webContents` (its own renderer process/pipeline),
so N tabs ≈ N renderer processes. (No single verbatim doc quote isolates per-view
memory cost — see gaps.) Practical mitigation is to cap live views and/or discard
(destroy + recreate) inactive tabs.

---

## 5. Main-process ownership + IPC boundary (SOLID shape)

Principle: the sandboxed React renderer must never receive a `webContents` handle. The
security model already forbids exposing privileged objects to a content renderer
(contextIsolation + no node integration, quoted §3), and the preload is the only place
allowed to bridge:

> "Specifies a script that will be loaded before other scripts run in the page." …
> "This script will always have access to node APIs no matter whether node integration
> is turned on or off." — preload, PRIMARY,
> https://www.electronjs.org/docs/latest/api/structures/web-preferences

Shape:
- MAIN process owns a `BrowserManager`: the map of tabId → WebContentsView, the
  BaseWindow contentView, per-tab sessions, and all event wiring (will-navigate,
  setWindowOpenHandler, will-download, setPermissionRequestHandler, context-menu).
- PRELOAD exposes a narrow, allow-listed API over `contextBridge` — verbs only, no
  raw handles.
- RENDERER (React) calls those verbs and subscribes to state events (title, url,
  canGoBack/canGoForward, loading). It also reports the layout rectangle so main can
  `setBounds`.

Sketch of the control contract (illustrative, grounded in the APIs cited above — not a
verbatim doc quote):

```ts
// preload.ts — the ONLY bridge; no webContents ever crosses it
contextBridge.exposeInMainWorld('browser', {
  newTab:    (url?: string) => ipcRenderer.invoke('browser:newTab', url),
  closeTab:  (tabId: string) => ipcRenderer.invoke('browser:closeTab', tabId),
  switchTab: (tabId: string) => ipcRenderer.invoke('browser:switchTab', tabId),
  navigate:  (tabId: string, url: string) => ipcRenderer.invoke('browser:navigate', { tabId, url }),
  back:      (tabId: string) => ipcRenderer.invoke('browser:back', tabId),
  forward:   (tabId: string) => ipcRenderer.invoke('browser:forward', tabId),
  reload:    (tabId: string) => ipcRenderer.invoke('browser:reload', tabId),
  setBounds: (rect: {x:number;y:number;width:number;height:number}) =>
               ipcRenderer.send('browser:setBounds', rect), // renderer reports layout
  onState:   (cb) => ipcRenderer.on('browser:state', (_e, s) => cb(s)), // url/title/loading/history
});
```

```ts
// main.ts — BrowserManager owns everything
ipcMain.handle('browser:navigate', (_e, { tabId, url }) =>
  tabs.get(tabId)?.webContents.loadURL(url));            // loadURL (§2)
ipcMain.handle('browser:back', (_e, tabId) =>
  tabs.get(tabId)?.webContents.navigationHistory.goBack()); // navigationHistory (§2)
ipcMain.handle('browser:switchTab', (_e, tabId) =>
  win.contentView.addChildView(tabs.get(tabId)!));        // re-add == bring to top (§4)
```

This keeps a single responsibility per layer (renderer = UI intent + layout;
main = view lifecycle + policy), depends on an abstraction (the verb API) rather than
concrete `webContents`, and is closed to the renderer gaining new privileges.

---

## Appendix — WebContentsView API surface in Electron 42

Present since Electron 30, so the full surface is available in 42. Confirmed from the
class doc (PRIMARY, https://www.electronjs.org/docs/latest/api/web-contents-view):
- Constructor: `new WebContentsView([options])` — options include `webPreferences`
  ("Settings of web page's features") and an optional `webContents` that, if passed,
  is "adopted by the WebContentsView."
- Property: `view.webContents` (read-only) — the real WebContents; "Use this to
  interact with the `WebContents`, for instance to load a URL."
- `class WebContentsView extends View` — so it inherits `setBounds`, `addChildView`,
  `removeChildView`, `children`, `setBorderRadius` from `View`.
- Constraint: "Electron's built-in classes cannot be subclassed in user code." — so
  wrap, don't extend.

(THIN / verify: the fetch did not enumerate every Electron-42-specific addition to the
class since 30. Before implementation, diff the WebContentsView page and Electron 31–42
release notes for any new methods/events, and confirm the exact `View.setBorderRadius`
and `addChildView(view[, index])` signatures on the live pages.)

---

## Gaps and open questions

- Verbatim fidelity: quotes were extracted via automated fetch. Spot-check the exact
  wording (esp. the THIN-marked items) against the live pages before pasting into code
  comments or the migration plan.
- addChildView index semantics: the docs confirm re-adding moves a view to the top and
  that an optional `index` exists, but did not return a verbatim sentence defining how
  a numeric `index` maps to stacking order. Confirm on the live View page.
- goBack/goForward deprecation on WebContents: inferred, not quoted verbatim from a
  deprecation banner — verify.
- Per-view / multi-tab memory: no authoritative quote on the per-WebContentsView memory
  cost; the "N tabs ≈ N renderer processes" claim is reasoning from the architecture,
  not a sourced number. Needs a benchmark or a doc/issue citation.
- Electron 42 ↔ Chromium 148 exact mapping was taken as given from the directive; not
  independently sourced here.
- Overlay strategy (menus/modals above the browser) is synthesized from the
  native-layer constraint; there is no single official "how to overlay DOM over a
  WebContentsView" recipe — validate the hide/shrink approach in a spike.
