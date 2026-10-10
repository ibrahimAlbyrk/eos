# Visual answers (generative UI) — implementation plan

Status: implemented, not yet run in the live app — tests (clean env): contracts 274/274 · core
1030/1030 · infra 630/631 (the one miss is the untouched real-Chrome CDP adapter flake, green on
re-run) · manager 2335/2335 · app/ui 1997/1997 (214 files, incl.
`app/ui/src/genui/boards.e2e.test.jsx`: all five boards from transcript rows through the real
ViewBlock, kit and AppFrame) · `app/ui` build · `app` typecheck · repo lint 0 errors (branch
`feat/genui`). Design canvas: https://claude.ai/artifact/WroKktRniSv8qHxY7Pabit (Overview ·
Scenarios · System pages — the scenarios, kit, states and architecture boards are the visual
spec for this plan).

When an agent has something to *show* — places, a plan, a comparison, a test run, a process —
it composes a native, interactive view inside the chat instead of a wall of markdown. Built
from Eos's own kit, streamed while it is written, wired back to the agent. Prior art and the
reasons for this shape are on the Overview board (GPT-6 Intelligent UI, Claude custom visuals,
Gemini/A2UI, MCP Apps, json-render / CopilotKit).

## Decisions (confirmed)

- **Three tiers.** Text stays the default. **Views** (`present`): the agent writes a spec, Eos
  renders it from a trusted catalog. **Apps** (`present_app`): agent-authored HTML/JS in a
  sandbox, for bespoke tools the catalog can't express.
- **Spec format:** entities once in JSON `data`; layout as a compact JSX-like `ui` string that
  only *references* the data (lenses). Small MCP schema, full validation in the handler.
- **Who gets it:** orchestrators and focused sessions. Workers don't — they report to the
  orchestrator, which presents.
- **Location:** macOS location permission, through the Electron app.
- **Map:** OpenFreeMap `dark` rendered by MapLibre GL, tiles through the daemon proxy (no key,
  commercial use allowed, no proxy/cache ban). Fallback: a self-hosted Protomaps extract.
- **Logos:** free stack by default (site icon, `og:image`, monogram); **logo.dev** as an
  optional publishable key (`pk_…`, 500k requests/month free; loaded straight from
  `img.logo.dev`, as its terms require — never proxied or stored; attribution link on the
  website). No Brandfetch, no Google Places in v1.
- **One build, not phases:** the whole system lands in one pass, built in parallel by
  specialist agents over a contract-first split (see Build).
- **Names:** UI copy says "visual answers"; code namespace is `genui` (`views/` already means
  screens in `app/ui/src/`). A rendered unit is a *view*, id `v_<12 base62>`.

## Shape

```
agent ──present{title,tone,data,actions,ui,summary}──▶ tool handler (manager)
   ▲                                                     │ POST /api/genui/views
   │                                                     ▼
   │                                  PresentView (core): catalog validate, limits, mint id
   │                                     │ ok → genui_views row      │ invalid → exact problems
   │                                     ▼                           └──▶ tool result (isError)
   │                    event log (tool_use input = the spec) ── SSE ──▶ UI
   │                                                                   │
   │  claude SDK lane only: input_json_delta ── genui:delta ─────────▶ │ partial render
   │                                                                   ▼
   │                                             ViewBlock → kit components (native, tokens)
   │                                                 │ local: filter/sort/select/step (free)
   └── next turn ◀── delivery ◀── POST …/message {text, action} ◀──┘ send-actions (reply chip)
```

## Spec

Tool input (key order matters for streaming — the model is told to write them in this order):

```ts
present({
  title: string,                       // ≤ 80
  tone?: "blue"|"green"|"amber"|"red"|"violet"|"teal",   // one accent per view
  icon?: IconName,                     // from the kit's icon set
  replaces?: ViewId,                   // updated version of an earlier view
  data?: Record<string, Entity[] | Json>,   // collections + scalars
  actions?: Record<string, Action>,
  ui: string,                          // markup, ≤ 24 KB
  summary: string,                     // required text fallback, ≤ 600
})
```

- **Entities** (`contracts/src/genui/entities.ts`): `Place`, `Product`, `Event`, `Person`,
  `Article`, `Media`, `File`, `Generic` — schema.org-like shapes, each with `id`. Shared optional
  fields: `image`, `site` (domain → logo), `url`, `source` (1 = `data.sources[0]`;
  `Stat`, `Rating`, `Quote` take `source=` too). Place:
  `rating 0–5`, `reviews`, `price 1–4`, `geo [lat,lon]` or `address`, `hours {until|closed|text}`,
  `area`, `cuisine`, `tags`. Unknown fields are kept for `{field}` templates.
- **Markup** (`ui`): XML-ish JSX — `<Tag a="text" b={json} flag>children</Tag>`; text children
  are inline markdown. `{…}` is JSON only, never JS. Collection components take `of="places"`;
  string attributes inside them may template fields (`meta="{cuisine} · {area}"`).
- **State**: inputs `bind="x"`; `<Value expr="…">` evaluates arithmetic over state and
  collection aggregates (`sum count min max avg`, `fv`, `round`) with a tiny safe evaluator —
  no identifiers outside state/data, no calls outside the whitelist.
- **Actions**: `{label, kind: "send"|"prefill"|"open"|"copy"|"set", primary?, text?, href?,
  set?}`. `send` text may template the item (`"Book {name} for {state.party}"`). At most two
  `primary`.
- **Limits** (validator, errors name the path): ui ≤ 24 KB, data ≤ 64 KB, depth ≤ 8, Carousel
  3–8 items, ≤ 1 Map, ≤ 40 images, ≤ 2 primary actions, `summary` required, tones/icons from the
  enums, `rating` 0–5, `geo` valid.

### Catalog v1 (one Zod schema each, `contracts/src/genui/catalog.ts`)

| Group | Components |
|---|---|
| Layout | `Section` `Stack` `Grid` `Split` `Carousel` `Tabs` (segmented, switches children) `Disclosure` `Divider` |
| Content | `Text` `Heading` `Image` `Gallery` `Logo` `Badge` `Rating` `Price` `Status` `Callout` `Quote` `Code` `FileRef` `Sources` |
| Data | `Stat` `KeyValue` `Table` (sortable, `best`) `Chart` (`bar` `line` `area` `donut` `sparkline`) `Meter` `Timeline` `Steps` `Progress` `Value` |
| Entities | `Card` (`kind` from the entity type; `variant` `row` · `compact` · `hero`) `Hero` (`pick`, badge, reason as children) `List` |
| Geo | `Map` (pins from a collection, `route`, `you`) |
| Inputs | `Filters` (chips bound to a collection) `Segmented` `Toggle` `Slider` `Stepper` `Select` `Field` `Checklist` `Choice` `Form` `Actions` |

Visuals are the System boards (Kit A, Kit B). Selection is shared per collection: a card, pin
and table row of the same entity highlight together.

## contracts — `contracts/src/genui/`

`catalog.ts` (component + entity + action schemas, limits), `spec.ts` (`PresentInput`,
`PresentAppInput`, `ViewRecord`, `ViewState`, `ViewAction`), `markup.ts` (tolerant parser:
complete tags → nodes, an unclosed tail is dropped; positions for error messages),
`partial-json.ts` (best-effort parse of a growing JSON prefix), `expr.ts` (safe evaluator),
`prompt.ts` (`catalogPrompt()` — the compact reference injected into the tool description, so
docs never drift from the schemas). `markup.ts`, `partial-json.ts`, `expr.ts` are dependency-free
so the UI imports them directly (as it does `attachments.ts`); `catalog.ts` (Zod) is daemon-side.

`http.ts`: request/response schemas below + ROUTES (+ `EXPECTED_KEYS`). `MessageRequestSchema`
gains optional `action: ViewAction` (`{viewId, actionId, label, item?, state?}`).

## Daemon

| Route | Does |
|---|---|
| `POST /api/genui/views` | agent plane (tool): validate, mint id, store → `{viewId, warnings}` or 400 with problems |
| `GET /api/genui/views/:id` | the stored spec (side-panel tab after reload) |
| `GET/PUT /api/genui/views/:id/state` | per-instance UI state (filters, ticks, step); ui-token on PUT; `genui:change` SSE |
| `POST /api/genui/apps` | `present_app`: validate (≤ 256 KB, one HTML doc), store → `{viewId}` |
| `GET /api/genui/media/img?src=` | image proxy + cache |
| `GET /api/genui/media/og?url=` | resolve a page's `og:image` / `twitter:image` |
| `GET /api/genui/media/icon?site=` | site icon (apple-touch-icon → icon → favicon) |
| `GET /api/genui/map/*` | OpenFreeMap style/tiles/glyphs/sprites proxy, URLs rewritten to itself |
| `GET /api/genui/geocode?q=` | Nominatim forward geocode (1 rps queue, persistent cache) |
| `POST /api/genui/places` | Overpass search near a point (`find_places` tool) |
| `GET /api/location` | current location via the app (LOCAL_ONLY); 403 unless sharing is on |

- **core** `use-cases/PresentView.ts` (validate via an injected validator port, limits, id via
  `newId`, `Clock`), ports `GenuiViewRepo`, `MediaFetcher`, `Geocoder`, `PlaceSearch`,
  `LocationSource`. No Node imports.
- **infra** `persistence/SqliteGenuiViewRepo.ts` + migration `064_genui_views` (`views` row:
  id, worker_id, kind view|app, title, data JSON, created_at; `view_state` row: id, data JSON —
  regenerable: a wipe only loses old views' rendering, the text summaries stay in the log);
  `media/` — fetcher with SSRF guard (http/https only, DNS-resolved private/loopback/link-local
  ranges refused, ≤ 3 redirects re-checked, 8 s timeout, image/* only, ≤ 8 MB, HTML ≤ 1 MB for
  og), disk cache `~/.eos/media-cache/` (LRU 500 MB, TTL 7 d, not in `USER_DATA_ENTRIES`,
  in-flight dedupe like `DarwinFsHelpers`); `geo/NominatimGeocoder.ts`,
  `geo/OverpassPlaceSearch.ts` (unique User-Agent, cached, ODbL attribution string returned).
- **manager**
  - Tools (`tools/defs/`): `present`, `present_app`, `find_places`, `current_location` →
    `orchestratorDefs` **and** `focusedDefs` (focused sessions are claude-lane only and get
    worker + focused defs; workers never see them). Registration snapshot + parity tests,
    `prompt-tool-names.ts`, `prompts/tool/*.prompt.md`. Errors follow `send_to_machine`'s
    `reasonOf` so the model sees `data.places[3].rating: 6.2 is outside 0–5`, not HTTP noise.
    Success text: `view v_… rendered · 6 places · 2 images unresolved → monograms`.
  - DPI fragments `role/orchestrator/17-present.prompt.md`, `role/focused/03-present.prompt.md`
    (`when: { fact: role, eq: … }`): when a view beats prose (and when it doesn't), data-once,
    key order, restraint, never invent (images come from `site`/`image`/search results; facts
    carry `source`; unknown → leave out), action kinds, tone choice, one compact example;
    `{{GENUI_LEVEL}}` filled at spawn from the setting (prompts are fixed at `start()`).
  - Streaming (claude SDK lane): `SdkEventMapper` handles `content_block_start` for tool_use
    named `*__present` and forwards `input_json_delta` as bus topic **`genui:delta`**
    `{workerId, callId, phase, text}` — a separate topic, so `LiveText`, iOS and
    `agent:delta` consumers are untouched. `SseBroadcaster` sends it with the same focus filter
    as `agent:delta`. Other lanes render on the complete call (skeleton while running).
  - View actions: `MessageRequestSchema.action` → `DispatchMessage` → model text
    `[view action] <label>` + JSON payload; stored `user_message` gains `action
    {viewId, label, viewTitle}` (display = the label); `MessageRecord`/queue carry it. Worker and
    orchestrator message routes both.
  - Compaction: `claude-transcript.ts` renders a `present` call as `[view] title — summary`
    instead of 2000 clipped chars of JSON.
  - Settings: `genui.level` (`rich` · `balanced` · `text`, default balanced), `genui.apps`
    (default on), `location.share` (default off) — settings.json keys; `location.share` and the
    optional logo key go through a ui-token-gated `PUT /api/settings/genui` (config block
    `genui {logoDevKey?}`, redacted on GET). `text` ⇒ `present` returns "Visual answers are off
    — answer in text".
  - **Security fix, required by the App tier:** the API server reflects any `Origin`,
    including `null`, so a sandboxed iframe could call ungated routes (`/workers/:id/message`,
    `/fs/read`). Reflect only `eos://app` (and the dev server origin), refuse `null`. Tests.

## App (Electron) — `app/src/main/`

- `onBeforeSendHeaders` on the main window's session adds `x-eos-ui-token` for
  `/api/genui/media/*` and `/api/genui/map/*` only (so `<img>` and MapLibre are authenticated;
  host views already get their view token). CSP: main window unchanged (loopback already
  allowed); host-view CSP unchanged (their proxy lives under `/h/<id>/`); `img-src` gains
  `https://img.logo.dev` only when a logo key is set.
- **Location:** `setPermissionRequestHandler` / `setPermissionCheckHandler` allow `geolocation`
  for the main window's `eos://app` only, deny host views and everything else. Forge
  `extendInfo`: `NSLocationUsageDescription` + `NSLocationWhenInUseUsageDescription`;
  entitlement `com.apple.security.personal-information.location`. The daemon asks through the
  existing app RPC (`c.appHost.rpc("", "location.get")`, new non-driver branch in
  `browser/channel.ts`) → main → the CoreLocation helper `eos-location` (`app/location/main.swift`,
  built by `app/scripts/build-location.mjs`, shipped in Contents/Resources) → `{lat, lon,
  accuracy, at}` or `denied | restricted | disabled | timeout | unavailable`; the daemon adds a
  reverse-geocoded area (cached). First grant happens from Settings (the prompt needs the app in
  the foreground).
  - *Why a helper:* the first build used `navigator.geolocation` in the main window. It timed
    out with no prompt: during the call locationd logged no Eos client at all — Electron never
    makes Chromium's system-permission request, so CoreLocation is never asked. locationd keys a
    command-line client by its own identity, so the helper carries its own Info.plist
    (`com.ibrahimalbyrk.eos.location`, name, usage string). It ships as `EosLocation.app`:
    linked into `__TEXT,__info_plist` of a bare binary, locationd registered it and posted the
    prompt, but CoreLocationAgent logged "client bundle is NULL. Skip showing AuthPrompt" —
    the prompt is shown only for a process that is the executable of a bundle.

## UI — `app/ui/src/genui/`

- `ViewBlock` — the content block for a `present` call: no tool chrome, never folded behind
  "Worked for…" (new block kind in `messageParser`, case in `Messages.renderBlock`, outside
  `WORK_KINDS`); states: streaming (from `genui:delta` via `streamStore`, parsed with the shared
  `partial-json` + `markup`), complete, failed call (one-line stub "couldn't render — fixed
  below"), render error (summary + "Show spec"), superseded (stub; derived conversation-wide
  through `useConversationBlocks`).
- `kit/` — one folder per group (`layout`, `content`, `data`, `entities`, `geo`, `inputs`),
  each exporting a name → component map; `kit/index.js` joins them. `kit/base.css` holds the
  view well, chips, wells, tones (the Kit A board tokens; glass rules from `glass.css`). Charts
  are hand-rolled SVG. Map: MapLibre GL (new dep) with `transformRequest` → daemon proxy;
  OpenFreeMap dark; attribution always; live only while on screen, at most 3 live maps,
  otherwise a canvas snapshot (Chromium drops old WebGL contexts).
- Images: `site` → `/media/icon`, `image` URL → `/media/img`, page URL → `/media/og`; failures
  → monogram (tone hashed from the name).
- State: `useViewState(viewId)` (GET/PUT, debounced, `genui:change`); selection is per
  collection; local actions never leave the client.
- Actions: `send` → `sendToAgent(text, {action})`, rendered as the reply chip (Tests board);
  `prefill` → `pushTextHandoff`; `open` → browser panel (`queueUrl`) or file panel; `copy`.
- Side panel: keyed tab `view:<viewId>` (re-derived from `GET /api/genui/views/:id`),
  fullscreen via the existing toggle; inline and panel copies share state.
- Apps: `AppFrame` — `<iframe srcdoc sandbox="allow-scripts allow-forms">` (opaque origin, no
  `allow-same-origin`), injected CSP meta (`default-src 'none'; script-src 'unsafe-inline';
  style-src 'unsafe-inline'; img-src data: blob: <media proxy>; font-src data:;
  connect-src 'none'`), theme as MCP Apps variables + Eos aliases. Bridge (MCP Apps subset):
  `ui/initialize` → host context; `size-changed` → height (≤ 720 inline); `ui/open-link` →
  browser panel; `ui/message` → an inline "App wants to send …  Send · Dismiss · Always for
  this app" chip (an app never talks to the agent silently). Messages accepted only when
  `event.source === iframe.contentWindow`. View source / reload / panel / fullscreen buttons.
- Settings: a "Visual answers" group in General (level, apps, location sharing with a "Test"
  button that triggers the permission prompt, optional logo key).

## Build — specialist agents in parallel

Branch `feat/genui` from `dev`. One shared working tree; every file has exactly one owner.
Names, routes, schemas and file paths in this plan are the contract between agents.

1. **Contracts** (first, blocks the rest): everything under `contracts/src/genui/`, `http.ts`
   (schemas, ROUTES, `EXPECTED_KEYS`, `MessageRequestSchema.action`), `route-planes.ts`,
   `index.ts`, contracts tests (schema fixtures for the five scenario boards, markup + partial
   JSON + expr edge cases).
2. Then in parallel:
   - **Agent plane** — tool defs + registry + snapshot + parity, tool/DPI prompts,
     `prompt-tool-names.ts`, `SdkEventMapper` streaming, `EventBus` topics, `SseBroadcaster`,
     message `action` plumbing (`DispatchMessage`, workers/orchestrators routes), compaction.
   - **Store & routes** — `PresentView` use-case + ports, Sqlite repo + `064_genui_views`,
     genui view/state/app routes, settings keys + config block + gated route, CORS fix,
     **owner of `container.ts` and `daemon.ts`** (wires every genui service and route by the
     names here).
   - **Media, geo & shell** — infra media/geo adapters, media/map/geocode/places/location
     routes (as `registerGenui*Routes` modules), `find_places` + `current_location` handlers,
     app main: header injection, permission handlers, location RPC, Forge plist + entitlement.
   - **UI core** — `ViewBlock`, stream store, `useLive` wiring, messageParser/Messages/turnFold,
     reply chip, view state hook, side-panel tab, settings UI, `api/routes.js` + client.
   - **Kit A** — layout, content, entities + `kit/base.css`.
   - **Kit B** — data, charts, inputs, `Value`, `Map` (+ `maplibre-gl` in `app/ui/package.json`).
   - **Apps** — `AppFrame`, srcdoc builder, bridge, confirmation chip.
3. **Integration** — wire-up gaps, `npm run lint`, every suite (contracts, infra, core via
   manager, manager, app/ui vitest + build), scenario fixtures rendered through the real
   renderer (`renderToStaticMarkup`) for all five boards.
4. **Review** — an adversarial review pass (security: SSRF guard, CORS, sandbox, bridge,
   location gating; correctness: streaming, actions, state) → fixes → green again.

No `eos build` / `eos restart` during the build (it would restart the daemon under running
workers). Nothing is committed until you ask; then commits are split per logical change.

## Tests

contracts: schemas accept the five scenario specs and reject each limit with the right path;
markup parser (unclosed tail, attributes, JSON attrs, inline markdown), partial JSON prefixes,
expr whitelist. core: `PresentView` (ids, limits, warnings). infra: repo, migration, SSRF guard
(private IPs, redirects to private, oversize, wrong type), cache LRU/TTL, Nominatim queue rate,
Overpass parsing. manager: tool registration/parity (orchestrator + focused only), handler
error text, routes (state PUT needs ui-token, location 403 when off, LOCAL_ONLY), mapper emits
`genui:delta` only for present, message `action` round trip, CORS refuses `null`, compaction
line. app/ui: ViewBlock states, partial render from a growing input, selection sync, filters,
`Value`, action → `sendToAgent` payload, reply chip, superseded, AppFrame bridge rejects foreign
sources + needs confirmation, settings controls.

## Not in v1

Hosting third-party MCP Apps (`ui://` resources need the SDK to surface `_meta.ui` and a
resource read — the bridge already speaks the protocol, so it plugs in later) · Google Places
(its terms forbid showing Places data next to a non-Google map outside the EEA) · Brandfetch
(hotlink-only, no proxy) · live views inside Pages (v1 "Save as page" writes a markdown
rendering) · a native phone renderer (phones show the summary) · user-approved custom
components.

## Notes

- OpenFreeMap has no SLA; the map provider sits behind the proxy route, so swapping to a
  self-hosted Protomaps extract or a keyed provider is a daemon change only.
- Nominatim allows 1 request/s: pins without `geo` appear progressively; `find_places` returns
  coordinates so most views never need it.
- A view's spec counts toward context once (it is the tool input); results stay one line.
