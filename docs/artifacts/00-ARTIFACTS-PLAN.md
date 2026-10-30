# Artifacts in the side panel

Open a claude.ai Artifact as a side-panel tab, instantly; show it live on hover; list every artifact of every Claude sign-in and open any of them.

Design (canvas): https://claude.ai/artifact/BLUSnX4ryWVrJkeDQtv9mP — chosen: **A · Quiet** (compact card, glass peek, docked list) with **B's floating glass toolbar** in the tab.

## Decisions

- **UI:** variant A (`Main.dc.html`, `A-Gallery.dc.html`) + B's floating toolbar.
- **Listing:** the frame API that Claude Code's own `Artifact` tool and `/artifacts` screen use, called per Eos sign-in with that sign-in's OAuth token. Undocumented and feature-flagged; Anthropic's terms forbid intermediating Claude.ai credentials, and `ClaudeUsageProvider` already takes the same risk. Accepted. The source sits behind a port, so a change in the API touches one adapter.

## Today

| Piece | Where | Problem |
|---|---|---|
| Card | `app/ui/src/lib/artifactLink.js` (`art-chip`), `ToolItem` badge, prose chips | A plain `<a href>`; the main window's navigation lockdown (`app/src/main/index.ts:125`) sends it to the system browser |
| Hover | `app/src/main/artifactPreview.ts` + `ArtifactPeek.jsx` + `artifactPreviewStore.js` | A hidden `BrowserWindow` loads the page, waits 2.6 s, CDP-screenshots a JPEG; cached 10 min by URL, so it shows whatever the page was at capture (an empty canvas right after publish) |
| List | `EnvironmentPanel.jsx` `ArtifactsSection` | This chat only; rows open the system browser |
| Account | — | One shared `persist:eos-claude` web session; nothing ties an artifact to the sign-in that made it |

## Facts the design rests on

- **Frame API** (base `https://api.anthropic.com`, `Authorization: Bearer <claudeAiOauth.accessToken>`, `anthropic-beta: oauth-2025-04-20`; the CLI requires scope `user:inference`):

  | Purpose | Request |
  |---|---|
  | List | `GET /api/frame/frames?limit=200` → `{frames:[{slug, title, favicon, description, rel: mine/shared, updatedAt, created_at, owner_email, audience, softDeleted, …}]}` — newest first, no paging, cap 200 |
  | Shared from other orgs | `GET /api/frame/frames/external` |
  | Boot | `GET /api/frame/{slug}?…` → `{ver, assetToken, title, mode, files, type, perm}` |
  | Content | `GET https://{slug}.frame.claudeusercontent.com/_f/{ver}/{path}?__frame_t={assetToken}` — no cookie, no bearer |
  | Versions (owner) | `GET /api/frame/versions/{slug}` |

- **No iframe.** claude.ai and the content host send `frame-ancestors` that exclude `eos://app`. A page renders only as a top-level document — a `WebContentsView`.
- **The claude.ai viewer has its own chrome:** a top bar (home, title, comments, Chat, Share) and a first-run "private by default" popover (seen in the cached previews).
- **Versions are immutable.** A still keyed by `slug@updatedAt` never goes stale for that version.
- **Two URL forms, one id:** `claude.ai/artifact/{22 chars}` is base58 (Bitcoin alphabet) of the UUID in `claude.ai/code/artifact/{uuid}`.
- **Electron 42:** `View.setBorderRadius` is available.

## Architecture

```
contracts  artifacts.ts · artifact-ids.ts   ArtifactSummary/Catalog schemas, id codec (base58 ⇄ uuid), routes
core       ports/ArtifactSource.ts          list(loginId) → ArtifactSummary[]
           services/ArtifactCatalogService   merge per sign-in, cache, stale-while-revalidate,
                                             invalidate on publish, publishes `artifacts:change`
infra      artifacts/FrameApiArtifactSource  fetch + injected token supplier, 401 → renew once
manager    routes/artifacts.ts               GET /api/artifacts · POST /api/artifacts/refresh (LOCAL_ONLY)
           container                         token helper shared with usage; publish detection at onAgentEvent
app main   artifacts/                        view pool (LRU), peek/tab placement, stills, claude.ai
                                             sessions per sign-in, bridge `eosArtifacts`
           preload/artifactOverlay.ts        the floating toolbar inside the view
           — replaces artifactPreview.ts
app/ui     state/artifactCatalogStore.js     /api/artifacts + `artifacts:change`
           views/artifacts/                  ArtifactCard · ArtifactPeek · ArtifactPanel · ArtifactsPanel
           registerPanels                    `artifact:<slug>` (one per artifact), `artifacts` (the list)
```

Dependency direction stays `contracts → core → infra → entrypoints`. Core never sees a token or a URL host; the adapter owns the wire shape and drops rows that fail the schema (as the CLI does).

### Interfaces

**Catalog (daemon).** `ArtifactSource.list(loginId, signal?)`; `ArtifactCatalogService` — `get()` returns the snapshot and starts a background refresh for any sign-in never read or older than 60 s; `refresh(loginId?)` re-reads now (one in-flight read per sign-in); `invalidate(loginId?)` schedules a refresh 1.5 s out (coalesced). Merge: newest `updatedAt` first, one row per slug (`mine` wins over `shared`). A failed read keeps that sign-in's last list and sets `accounts[].error`. Every change publishes `artifacts:change` with only `{ refreshing }`: the stream also reaches paired computers, so the dashboard reads the catalog itself from the local-only route.

**Publish detection.** At the `onAgentEvent` sink, a `message` whose `tool_result` text holds a claude.ai artifact URL invalidates the sign-in that worker runs on (any sign-in when unknown).

**Bridge `window.eosArtifacts`** (main window only; host views don't get it):

```ts
type Ref = { slug: string; loginId: string | null; url: string; version?: string; title?: string };
type Rect = { x: number; y: number; width: number; height: number }; // getBoundingClientRect, CSS px
type ViewState = "idle" | "loading" | "ready" | "signin" | "error";

warm(ref): void                              // create + load off-screen
peek(ref, rect): void                        // live miniature (zoom .5) at rect, radius 10, toolbar hidden;
                                             // a shield takes its input: click = open, ⌥-click = claude.ai
unpeek(): void
attach(tabKey, ref, rect): void              // show in a tab at rect, radius 12, toolbar shown
setBounds(tabKey, rect): void
setVisible(tabKey, visible): void            // false while the tab is hidden, occluded or under an overlay
detach(tabKey): void
reload(slug): void
setToolbar(slug, { initial, account, meta }): void
still(ref): Promise<string | null>           // cached JPEG data URL for slug@version
state(slug): Promise<ViewState>
onState(cb: ({ slug, state, error? }) => void): () => void
onAction(cb: ({ slug, action: "all-artifacts" | "open" }) => void): () => void  // "open": a click on the peek's miniature
account(loginId, expectedEmail?): Promise<{ signedIn: boolean; email?: string }>
signIn(loginId, expectedEmail?): Promise<{ signedIn: boolean; email?: string }>
signOut(loginId): Promise<void>
```

`tabKey` = `<paneId>/<tabId>`: a view lives in one place; the newest `attach`/`peek` takes it and the other place shows the still. Sessions: `persist:eos-claude-<loginId>`; the existing `persist:eos-claude` is adopted for the sign-in whose email it is signed in as (`claude.ai/api/account`), recorded in `<userData>/artifact-sessions.json`.

### Fast open

1. **One live view, three places.** A view is created warm (off-screen), shown in the peek as a miniature (per-view `insertCSS('html{zoom:.5}')` — zoom on the view, not the origin), and on click the *same* `webContents` moves into the panel with the zoom removed. No reload between hover and open.
2. **Warm-up.** The chat's newest artifact warms when its card scrolls into view; any other on 120 ms hover intent. Pool cap 4 views, LRU, idle views closed after 5 min.
3. **Still first.** The peek and the tab paint the cached still for `slug@updatedAt` at once and cross-fade to the live view on `ready-to-show`.
4. **Catalog cached.** The list returns from memory; a refresh runs on window focus (≥ 60 s since the last), on opening the list, after an Eos agent publishes (that sign-in only), and from the refresh button.
5. **Republish → reload.** When an agent republishes an open artifact, its view reloads; edits made elsewhere show on the next refresh.

### Render route

The claude.ai viewer page (`claude.ai/artifact/<shortId>`) in a partition signed in to claude.ai — one partition per Eos sign-in, since an artifact opens only for its owner. The direct content-host route is closed (Phase 0). The viewer keeps its own top bar (title, comments, Chat, Share); the Eos toolbar carries only what that bar lacks.

### Floating toolbar over a native view

A `WebContentsView` paints above the DOM, so a DOM toolbar cannot float over the page. The artifact view's own preload (`app/src/preload/artifactOverlay.ts`, isolated world) draws it: a closed shadow root at the bottom centre styled by a constructable stylesheet (claude.ai's nonce CSP blocks inline style attributes, not CSSOM), with real backdrop blur over the live page; clicks go to main over IPC and are honoured only when `isTrusted`. Contents: account initial · version label or update time, reload, copy link, all artifacts, open on claude.ai. Hidden in the peek; fades while the page scrolls.

The peek is a DOM glass frame with the native view inside its inner rect (`setBorderRadius(10)`), so nothing overlaps. Menus and modals over the tab reuse the browser panel's overlay/occlusion pattern: that logic moves out of `browser/views.ts` `applyGeometry` into a shared `NativeViewSlot`, so both panels use one implementation.

### Accounts

- A chat card's account is the sign-in the session ran on when it published (origin record), else the catalog match by slug.
- The list groups by sign-in label (`PlanLoginService`), with an account filter and Mine / Shared.
- No Claude sign-in → the list says to sign in under Settings › Accounts.

### Interaction

- **Click:** open (or focus) the artifact's own tab, `artifact:<slug>`. **⌥-click:** claude.ai in the system browser. Every artifact already has its own tab, so there is no separate pinned tab.
- Applies to the tool-row card, prose chips, Environment rows and list rows.
- The list is reachable from the toolbar, the New tab launcher and the Environment popover.

## Security

- Views: `sandbox`, `contextIsolation`, deny-all permissions (clipboard write aside), popups and any navigation off the claude.ai artifact viewer paths → system browser.
- OAuth tokens never leave the daemon. Views use their partition's claude.ai web session; Eos never reads its cookies beyond checking that `sessionKey` exists.
- The overlay preload exposes nothing to the page.
- Routes are ui-token and LOCAL_ONLY (account data); the `eosArtifacts` bridge is withheld from host views, as `eosArtifactPreview` is today.

## Phases

0. **Spike — done (2026-10-29).** Findings:
   - **Frame API with Eos tokens works** when the request carries `X-Frame-Surface: code` and `X-Frame-CP: go` (without them: 404). 116 artifacts in ~0.9 s; boot ~0.25 s. `/frames/external` answers 403 — not used. A lapsed sign-in has no token until the usual refresh runs.
   - **List rows** carry `slug, title, favicon (emoji), icon, tint, type_title, label, live (version id), rel, audience, updatedAt, created_at, last_viewed_at, thumbPending`. Server thumbnails exist but their URL isn't reachable with these tokens → Eos keeps its own stills.
   - **Direct route closed:** the content host loads with only the asset token (it sets a `__Host-frame-asset-<ver>` cookie for subresources), but a top-level load redirects to `claude.ai/code/frame/<slug>`, which needs a claude.ai web session. Render = viewer page.
   - **Overlay:** inline style attributes are blocked by claude.ai's nonce CSP; a closed shadow root with a constructable stylesheet renders, blur included.
   - **Peek miniature:** `insertCSS("html{zoom:.5}")` scales one view only.
1. **Catalog (daemon):** core port + service, infra adapter, routes, publish detection, tests.
2. **View host (app main):** pool, stills, sessions, overlay preload, bridge; delete `artifactPreview.ts`.
3. **Chat:** card, peek, click routing, `artifact:<slug>` tab with toolbar.
4. **List:** `artifacts` tab, New tab entry, Environment rows open the panel.
5. **Docs:** CLAUDE.md key-decision entry.

## Tests

- Pure: id codec, catalog merge + stale-while-revalidate, pool LRU, click-modifier routing.
- Infra: `FrameApiArtifactSource` against a stubbed fetch — 401 → one renew, malformed rows skipped, `softDeleted` dropped.
- UI (vitest): card/peek states, list filters.
- Manual: hover-to-live and click-to-paint times, recorded in this doc.
