# Eos iOS Redesign Contract

Decision-final spec for rebuilding `ios/` to the Claude-iOS-app quality bar (11 reference
screenshots) while keeping the Eos brand and mirroring the Mac app's semantics. Implementation
packages build from this file without further design decisions. Sections: A design system ·
B navigation · C per-screen specs · D agents tree · E safe-area/keyboard · F API wiring ·
G backend work · H file-ownership map · Decisions · master-item checklist.

Conventions used below:
- "ref: IMG_44xx" = the reference screenshot that sets layout/spacing/anatomy.
- "Mac: file" = the Mac component whose semantics are mirrored (app/ui/src/...).
- Endpoints are tunneled ControlFrames over the device WS (`DeviceConnection.control`),
  identical to local REST paths.
- All new SwiftUI code is dark-locked (`.preferredColorScheme(.dark)` stays in `eosTheme()`).

---

## A. Design system

### A1. Tokens (DesignSystem/)

Keep the existing v2 palette unchanged. `EosColor.coral` stays `#6EA4E8` — it matches the Mac
dashboard `--accent: #6ea4e8` exactly (app/ui/src/styles.css:106); the token NAME is historical.
Additions (all additive, no renames):

| Token | Value | Use |
|---|---|---|
| `EosColor.attention` | alias of `EosColor.State.queuedDot` (#0099FF) | attention dot (agent stopped w/ unviewed output) — matches Mac `.ag-notify` blue |
| `EosRadius.sheet` | 32 | bottom-sheet top corners (ref IMG_4424/4430/4436) |
| `EosRadius.menu` | 20 | anchored menus / dialogs (ref IMG_4431/4432/4433) |
| `EosRadius.banner` | 20 | permission banner card |
| `EosSpacing.grabberW/H` | 36 / 5 | sheet grabber capsule |

Typography and spacing scales are unchanged. Model/effort display names come from the new
`ModelCatalog` (A4), not from hardcoded switches — `shortModel()` dies with `ModelPill.swift`.

### A2. Glass recipes

Three surface classes; never nest glass in glass:

1. **Floating chrome** (top-bar buttons, composer card): `.glassEffect(.regular, in: shape)` on
   the container; children are content-on-glass. Composer keeps the Reduce-Transparency opaque
   fallback that exists today.
2. **Bottom sheet** (model / mode / repo / device switcher / effort): opaque dark —
   `.presentationBackground(EosColor.surface)`, `.presentationCornerRadius(EosRadius.sheet)`,
   custom grabber + header (A3). Reference sheets are opaque, not translucent.
3. **Dialog / menu** (rename dialog, three-dot menu, attach menu): three-dot + attach menus are
   native SwiftUI `Menu`/`.contextMenu` (iOS 26 gives them system glass for free). The rename
   dialog is a custom `GlassDialog` centered card: `.glassEffect(.regular, in:
   .rect(cornerRadius: EosRadius.menu))` over a 0.28-alpha ink scrim (ref IMG_4433).

### A3. Sheet anatomy — `EosSheetHeader` + `.eosSheet()` (new components)

Every bottom sheet in the app uses one chrome (ref IMG_4424/4430/4436):

- Grabber: 36×5 capsule, `EosColor.inkFaint`, centered, 10pt from top.
- Header row (8pt below grabber): leading 36pt glass circle **X** button
  (`CircularIconButton(systemName: "xmark", diameter: 36, glass: true)`), centered title in
  `EosFont.labelStrong`, trailing 36pt spacer for symmetry.
- Content begins 16pt below header, inset `EosSpacing.screenInset`.
- Modifier `.eosSheet(detents: Set<PresentationDetent>)` applies: background `EosColor.surface`,
  corner 32, `presentationDragIndicator(.hidden)` (we draw our own grabber), detents.
- Row primitive `SelectRow(icon:title:subtitle:selected:)`: optional 22pt leading icon, title
  `EosFont.label` in `ink`, subtitle `EosFont.caption` in `inkSecondary`, trailing coral
  `checkmark` when selected, hairline separator inset to text (ref IMG_4424 rows).

### A4. Model catalog (data-side, consumed by pickers)

Port of Mac `lib/models.js` (`curateCatalog`, `EFFORTS`, `effortChoicesFor`) into
`EosRemoteKit/Models/UiConfig.swift`:

- Baseline families (shown until `/api/ui-config` arrives): haiku / sonnet / opus / fable with the
  Mac blurb tags — "Fastest for quick answers" (haiku), "Most efficient for everyday tasks"
  (sonnet), "For complex tasks" (opus), "For your toughest challenges" (fable) — mapped from the
  Mac tags fastest/balanced/most capable/most powerful into the reference's sentence style
  (ref IMG_4424 blurbs).
- `curate(catalog:[CatalogModel])`: per family pick latest `createdAt` id matching
  `claude-<family>-…`, derive short id, `displayName` (strip "Claude "), `ctxTokens` from
  `maxInputTokens` (label "200k"/"1M"), `efforts` from `effortLevels`.
- Efforts: `low/medium/high/xhigh/max/ultracode`, labels Low/Medium/High/Extra/Max/Ultracode.
  `effortChoices(model)` gates API levels by catalog `effortLevels` (null → all, [] → hide);
  `ultracode` survives whenever the model supports any effort (Mac rule).
- Commit values: model = family alias ("opus", "fable"…) exactly like Mac ModelPopover
  (`m.aliases[0]`); effort = the id string. Defaults: **opus / xhigh**.

### A5. Motion + haptics (`DesignSystem/Motion.swift`)

- `EosSpring.drawer` = `.interactiveSpring(response: 0.35, dampingFraction: 0.86)` (existing).
- `EosSpring.sheet` = `.spring(response: 0.4, dampingFraction: 0.9)` — sheet content transitions.
- `EosSpring.chip` = `.spring(response: 0.3, dampingFraction: 0.8)` — chip insert/remove,
  banner stack shuffle.
- `Haptics.tap()` (UIImpactFeedbackGenerator .light) — chip select, mode/model pick, menu open.
- `Haptics.success()` / `Haptics.warning()` (UINotificationFeedbackGenerator) — permission
  Allow / Deny, send, archive.
- Reduce Motion: all springs fall back to `.none` (existing SidebarContainer pattern).

---

## B. Navigation architecture

### B1. Shell

`RootView` keeps `SidebarContainer { DrawerView | NavigationStack }`. Sections shrink to two:

```swift
enum SidebarSection: String { case code, devices }   // was fleet/pending/devices/settings
```

NavigationStack root = **CodeListView** (per `sidebar.section == .code`) or **DevicesView**
(`.devices`). Push destinations (`NavigationPath` of a `Route` enum, replacing bare String):

```swift
enum Route: Hashable { case conversation(String /*workerId*/), newSession }
```

Sheets owned by RootView: `PairingView`, `AddDeviceSheet`, `DeviceSwitcherSheet`.
Sheets owned by screens: ModelSheet, ModeSheet, RepoPickerSheet (see C).
Deep links: `eos://worker/<id>` → push `.conversation(id)`; `eos://pending` → pop to CodeListView
(permission asks now live as banners in conversations; the Code list waiting indicator guides the
user in).

### B2. Screens after the redesign

| Screen | File | Kind |
|---|---|---|
| Drawer | `App/DrawerView.swift` (new) | overlay panel |
| Code list (sessions) | `Views/CodeListView.swift` (new) | stack root |
| Conversation | `Views/WorkerDetailView.swift` (rewritten in place) | push |
| New session | `Views/NewSessionView.swift` (new) | push |
| Model + effort sheet | `Views/Sheets/ModelSheet.swift` (new) | sheet |
| Mode sheet | `Views/Sheets/ModeSheet.swift` (new) | sheet |
| Repo picker + browser | `Views/Sheets/RepoPickerSheet.swift` (new) | sheet |
| Device switcher | `App/DeviceSwitcherSheet.swift` (new) | sheet |
| Devices manage (+rename) | `Views/DevicesView.swift` (edited) | stack root (section) |
| Attachment menu | native `Menu` inside `ChatComposer` usage | anchored menu |
| Three-dot menu | native `Menu` in conversation header | anchored menu |
| Rename dialog | `GlassDialog` component | overlay |
| Pairing / Add device / QR | existing files, untouched | sheet |

### B3. Files that die

`Views/HomeView.swift`, `Views/FleetView.swift`, `Views/SpawnSheet.swift`,
`Views/PendingListView.swift`, `Views/SettingsView.swift`, `Views/ModelPickerSheet.swift`,
`Views/AskUserSheet.swift` (orphan), `App/SidebarView.swift`, `App/AccountLabel.swift`,
`DesignSystem/Components/Avatar.swift`, `DesignSystem/Components/Composer.swift` (replaced by
`ChatComposer`), `DesignSystem/Components/ModelPill.swift` (model selection moves to
title/menu; display names from ModelCatalog). Deletion ownership: §H.

The transcript renderer (`Views/Messages/**`, `Views/BlockView.swift`) is kept as-is except the
one `UserMessageView` edit in §C3.

---

## C. Per-screen specs

Common state rules (apply to every screen; restated only where behavior differs):
- **Offline** (active device not connected): content stays (cached Store), a thin banner chip
  under the top bar: dot + "Reconnecting to <device>…" (`connecting`) or "Not connected — pull
  to retry" (error). Mutating controls disabled (55% opacity).
- **Loading**: skeleton/`ProgressView` only when there is no cached data.
- **Error** on a mutation: `lastError` surfaces as a transient toast-style capsule above the
  composer/bottom edge, auto-dismiss 4s.

### C1. Drawer (ref IMG_4423 · replaces SidebarView)

Layout, top→bottom, full-height edge-to-edge (`.ignoresSafeArea()`), width
`min(containerWidth * 0.85, 360)`, opaque `EosColor.bg` (reference drawer is opaque; drop the
glass panel):

1. Wordmark: `Text("eos")` `EosFont.titleSerif`, tracking −0.5, top padding
   `safeAreaInsets.top + EosSpacing.lg`, leading `EosSpacing.md`.
2. Device chip (8pt below): existing `CurrentDeviceChip` anatomy (StateDot + label + chevron) —
   action changes: opens **DeviceSwitcherSheet** (was: jump to Devices section). Hidden when no
   devices (pairing sheet auto-presents instead).
3. Nav rows (16pt below): `SidebarRow("chevron.left.forwardslash.chevron.right", "Code")` and
   `SidebarRow("laptopcomputer", "Devices")`. Selected row = existing selected treatment.
4. `SectionCaption("Recents")` + scrollable list: last 12 workers of the active device sorted by
   `recencyKey` desc (D3), rows = `SidebarRecentRow` (state dot + name); tap → push
   `.conversation(id)`, close drawer. Orchestrators and workers both appear (flat here; the tree
   lives in Code list). Empty: caption hidden.
5. Floating **"+ New session"** pill, bottom-RIGHT (ref IMG_4423 "New chat"), 16pt from
   trailing/bottom safe area, `EosColor.ink` background + `EosColor.black` label/icon (the
   light-on-dark pill of the reference), `plus` icon. Action: close drawer, push `.newSession`.
   NO avatar bottom-left (master 13).

Container (`SidebarContainer` edits): drawer pinned left full-height, no corner radius on the
drawer itself; main content offsets right by drawer width, clipped to
`RoundedRectangle(cornerRadius: 39 * progress)` + scrim (existing behavior kept); edge-gated drag
kept. Data: `model.devices`, `model.activeDevice`, `model.connectionState(for:)`,
`model.workers`.

### C2. Code list (ref IMG_4434 anatomy + IMG_4428 floating pills · replaces HomeView)

Top bar (TopChrome variant): glass hamburger left, centered title **"Code"**
(`EosFont.labelStrong`), trailing 40pt **coral filled circle "+"** (`plus.bubble`-style; use
`plus` glyph, `.glassProminent` tinted coral — ref IMG_4434) → push `.newSession`.

Under the bar: **filter chips** row, horizontal, `FilterChip` capsules with count badges:
`All n · Running n · Archived n` (decision: Running replaces the reference's "Completed" —
Eos sessions don't complete, they idle). Counts: All = live roots; Running = roots whose subtree
has a running member; Archived = archived roots (fetched lazily on first switch, then cached +
refreshed on each switch).

Body per filter:
- **All / Running**: the agents tree (§D). LazyVStack in a ScrollView; roots =
  orchestrator cards, children indented beneath. No month sections here — running-first sort
  owns the order (decision).
- **Archived**: month section headers ("July", "June" …) from `archived_at` desc (ref
  IMG_4434), rows = same OrchestratorRow anatomy minus live dot (state forced idle), trailing
  relative date. Swipe leading: **Restore** (`POST /workers/:id/restore`), then refresh both
  lists. Tap → conversation in read-only mode (C3 archived state).

Row swipe actions (All/Running, roots only): trailing **Archive**
(`archivebox`, `POST /workers/:id/archive`) with `Haptics.warning`. No kill/delete on phone
(decision — destructive purge stays on the Mac).

States: empty All → centered DawnStar(40) + "No sessions yet" + ghost pill "New session";
empty Archived → "Nothing archived"; loading (first fetch, no cache) → 3 skeleton rows.
Data: `model.workers` (live, SSE-patched via Store), `model.archived` (new published array,
`GET /workers/archived`).

### C3. Conversation (ref IMG_4429 · rewrite of WorkerDetailView, file kept)

Header (screen-local, not TopChrome): glass back chevron circle (40) left — `dismiss` /
`path.removeLast()`; centered session title (`nameOf` fallback: `name ?? (is_orchestrator ?
"Orchestrator" : id)`), single line, `EosFont.labelStrong`; trailing glass three-dot circle (40)
→ SessionMenu (C13). Gradient backdrop per §E1.

Body: existing transcript pipeline unchanged (TaskFromView, LoopStatusCard, MessageView list,
GoalCheckLine/ProcessingLine, TranscriptFoot, `.defaultScrollAnchor(.bottom)`, backward paging).
Additions:
- `.simultaneousGesture(TapGesture().onEnded { composerFocused = false })` on the ScrollView
  (tap-outside keyboard dismiss, master 17) + keep `.scrollDismissesKeyboard(.interactively)`.
- `UserMessageView`: port `parseAttachmentMessage` (Mac lib/attachmentTokens.js) — split the
  `\n\nattachments:\n` suffix off the bubble text and render compact chips (icon + filename)
  under the text instead of the raw suffix.

**Permission banner** (master 11, replaces pending section/chrome button): stacked banner
pinned ABOVE the composer inside the bottom `safeAreaInset` VStack. Scope: pending asks whose
`worker_id` is the open agent **or any of its descendants** (decision D-9; Mac filters to the
exact selected worker, but the phone has no always-visible tree, and the operator lives in the
orchestrator chat). Anatomy (PermissionBanner component, Mac center/PermissionBanner.jsx):
- Card: `EosColor.surface2`, radius `EosRadius.banner`, hairline border; up to 2 ghost cards
  peeking 4/8pt beneath when more are queued, "N pending" count chip top-right.
- Header: amber dot (`State.waitingDot`) + `Allow <worker name> to run <tool_name>?` —
  `EosFont.label`, worker/tool in SemiBold.
- Detail: first of `input.command ?? file_path ?? path ?? query ?? regex` (parse `input` JSON
  string), `EosFont.code`, 3-line cap, `surface3` well.
- Actions row: `Deny` (ghost, `danger` text) left; right group `Always allow` (ghost) +
  `Allow once` (coral filled capsule). Busy state disables all three.
- Wiring: Allow once → `POST /pending/:id/decision {decision:"allow"}`. Always allow → same
  decision POST **then** `POST /api/policy/rule {tool, behavior:"allow"}` fire-and-forget (Mac
  usePendingPermissions.js order). Deny → `{decision:"deny"}`. `Haptics.success/.warning`.
  Resolved/expired rows drop via the existing Store pending patches.

**Composer**: `ChatComposer` (A/H contract) — text field ("Reply to <name>" placeholder),
bottom row `[ModePill] spacer [⊕ attach] [↑ send]`:
- ModePill (ref IMG_4429 "</> Accept edits"): icon `chevron.left.forwardslash.chevron.right`,
  label = current `permission_mode` display (Accept edits / Full Access). Tap → ModeSheet (C7);
  pick → `PUT /workers/:id/permission {mode}` (no cascade — Mac AcceptPopover sends none),
  optimistic pill update, revert on error.
- Attach ⊕ → anchored attachment menu (C8).
- Send: enabled when text non-empty AND no chip uploading; sends
  `text + attachmentSuffix` via `POST /orchestrators/:id/message` when `is_orchestrator`, else
  `POST /workers/:id/message`, body `{text, clientMsgId, queueWhenBusy:true}` (existing
  optimistic-bubble path kept). While busy the message queues daemon-side (exists) — no extra UI
  this phase (queue list = later).
- AttachmentChipRow renders above the field when `draft.items` non-empty (C8).

Interrupt moves from top chrome into… nothing is lost: interrupt lives as the send button's
alternate — when the worker `isBusy` AND the text field is empty, the trailing button renders
`stop.fill` (coral) → `POST /workers/:id/interrupt` (Mac composer parity). With text present the
send arrow returns (message queues).

Attention: on open + on close call `model.markViewed(workerId)` (D4).
Archived worker (opened from Archived filter): composer + banner hidden; bottom bar shows a
single `Restore session` pill → restore + reload row.
States: transcript loading → existing spinner row; offline → banner per common rule; deleted
worker (404 on events) → pop with toast.

### C4. New session (ref IMG_4435 · new, replaces SpawnSheet + Home fast-path)

Header: glass back chevron left; centered **model title button**: `<ModelDisplayName> ⌄`
(`EosFont.labelStrong` + `chevron.down` 12pt) → ModelSheet (C6). Trailing: none.
Under header, centered: **device chip** (StateDot + active device label, capsule) → tap →
DeviceSwitcherSheet (decision: the reference's "Default" cloud chip maps to the paired Mac).

Body (VStack, top-aligned, scrollable when keyboard up):
- `SectionCaption("Suggestions")` + 3 static suggestion capsules (decision: static, no backend):
  "Fix the failing tests in my repo", "Refactor a file and explain the changes",
  "Find and fix a TODO". Tap = insert into composer text.
- Spacer pushes the repo row + composer to the bottom.

Repo chip row (above composer, ref IMG_4435): a capsule chip `folder` glyph + chosen repo
basename (`EosColor.surface`, hairline). Tap → RepoPickerSheet (C9). Initial value: first path
from `GET /fs/recents` (fetched on appear); if recents empty, chip reads "Choose folder…" in
`inkTertiary`.

Composer: same `ChatComposer` with placeholder "Code anything…", ModePill (local pre-spawn state,
default `acceptEdits`), attach ⊕, send ↑. **No mic** (master 12).

Lazy create (master 6): nothing is POSTed until first send. On send:
1. Require a cwd: if none chosen and recents empty → present RepoPickerSheet, hold the draft.
2. `POST /orchestrators {cwd, name: nil, model, effort, prompt: text+attachmentSuffix,
   permissionMode, backendProfile?}` — model/effort from the ModelSheet state (defaults
   opus/xhigh), `backendProfile` set only when a provider profile was picked.
3. On `{id}` → replace the current nav entry with `.conversation(id)` (no flash of the list).
4. Errors: keep draft, show error capsule.

States: recents loading → chip shows spinner; offline → send disabled + banner.

### C5. Effort UI — spec'd as ModelSheet page 2 (see C6); no standalone effort surface exists.

### C6. Model sheet + effort UI (ref IMG_4424 · new ModelSheet, replaces ModelPickerSheet)

`.eosSheet(detents: [.medium, .large])`, `EosSheetHeader("Select model")`. Content is a
NavigationStack-in-sheet with two pages:

Page 1 — models. Data: `model.uiConfig` (`GET /api/ui-config`, fetched once per connect, cached
on AppModel; refetch on device switch). Groups, each a rounded `surface` card of `SelectRow`s
split by hairlines:
1. **Claude** (subscription lane): curated families from `modelCatalog` via A4 — row title =
   displayName ("Fable 5"), subtitle = blurb + " · " + ctx label ("For your toughest
   challenges · 1M"). Checkmark on current. Shown only when a subscription backend is enabled
   (`backends[]` where `billing == "subscription"` and `enabled`) — else the group renders with
   the baseline families anyway (offline-safe default) since spawn falls back daemon-side.
2. **Providers** (`backendProfiles[]`, when non-empty): row title = profile `label`, subtitle =
   `kind · model`. Picking a profile commits `backendProfile = name` (model display = profile's
   pinned model; conversation runtime-switch to a profile is out of scope — hidden there, see
   below).
Selection commits immediately (Haptics.tap) and dismisses is NOT automatic — X closes (ref).
   - New-session context: updates local draft (model alias or backendProfile).
   - Conversation context (from three-dot "Change model"): `PUT /workers/:id/model
     {model: alias, effort: currentEffort}`; the Providers group is hidden (runtime provider
     switch is a backend/capability question — later).
3. **Effort row** (pinned card under the list, ref IMG_4424): `Effort` label left, current
   effort label + chevron right → pushes Page 2.

Page 2 — effort. `EosSheetHeader("Effort")` with back instead of X (chevron.backward circle).
Rows from `effortChoices(currentModel)` (A4): title = label (Low/Medium/High/Extra/Max/
Ultracode), subtitle only for Ultracode ("Extra effort plus workflows — heaviest on limits"),
checkmark on current. Pick → commit (draft update, or `PUT /workers/:id/model {model, effort}`
in conversation context) and pop to page 1.

States: uiConfig not yet loaded → baseline families render immediately (A4), spinner footer;
fetch error → baseline + quiet "showing defaults" caption.

### C7. Mode sheet (ref IMG_4430 anatomy, Mac list · new ModeSheet)

`.eosSheet(detents: [.height(280)])`, `EosSheetHeader("Select mode")`. EXACTLY two rows
(Mac lib/permissionModes.jsx — master 18):

| icon | title | subtitle | id |
|---|---|---|---|
| `checkmark.shield` (coral) | Accept edits | Auto-approve file edits, ask for shell | `acceptEdits` |
| `exclamationmark.shield` (violet `State.violetDot`) | Full Access | Auto-approve everything, including shell | `bypassPermissions` |

Checkmark on active. Pick → callback `(PermissionMode) -> Void` (owner decides: local draft on
NewSession; `PUT /workers/:id/permission {mode}` on conversation), Haptics.tap, dismiss.

### C8. Attachment menu + pipeline (ref IMG_4431 · master 15/16)

**Menu**: the composer's ⊕ is a native SwiftUI `Menu` (system glass, anchors above the button):
- `Take Photo` (`camera`) → full-screen `UIImagePickerController(sourceType: .camera)` wrapper
  (`NSCameraUsageDescription` already present).
- `Choose photo or video` (`photo.on.rectangle`) → `PhotosPicker` (images + video; video passes
  through as a file, no transcode).
- `Choose file` (`doc.text`) → `.fileImporter(allowedContentTypes: [.item],
  allowsMultipleSelection: true)`.

**Pipeline** (`AttachmentDraftModel`, one instance per composer):
1. Normalize: images (incl. HEIC, camera) re-encode JPEG, longest edge ≤ 2048px, quality 0.8;
   files/videos read raw via security-scoped URL. Reject payloads > 3 MB post-normalize with an
   error toast ("Too large to send from phone — 3 MB max") — the relay envelope caps frames at
   5 MB and base64 inflates 4/3 (decision D-11).
2. Append chip `status: .uploading` (label from ported `makeLabel(name)` — 24-char cap,
   bracket-stripped, `n`-suffix dedupe).
3. Upload: `DeviceConnection.uploadAttachment(name:data:)` → `POST /fs/paste-b64
   {name, dataB64}` → `{path}` (NEW route — §G; mirrors `/fs/paste` which is unreachable over
   the JSON control tunnel). Success → `.ready(path:)`; failure → `.error` (chip turns
   `danger`-tinted, tap = retry, × = remove).
4. Send: blocked while any `.uploading` (send button 35% opacity). On send append the Mac wire
   suffix verbatim (`buildAttachmentSuffix` port):
   `\n\nattachments:\n- [label] (image|file): /abs/path` per chip. Kinds on phone: `image` |
   `file` (no folder source). Clear chips after send.

**AttachmentChipRow** (above the text field): 56pt chips — image chips show the thumbnail
(rounded 12), file chips a doc glyph tile; name caption beneath (1 line); uploading = spinner
overlay; × remove button top-right. Horizontal scroll when overflowing.

### C9. Repo picker + directory browser (ref IMG_4436 · master 21)

`RepoPickerSheet`, `.eosSheet(detents: [.large])`, `EosSheetHeader("Choose folder")`.
NavigationStack-in-sheet:

Page 1 — recents. Search field capsule pinned bottom (ref IMG_4436) filtering locally.
Rows: title = last path component, subtitle = path abbreviated (`/Users/x/…/parent`), coral check
on the currently chosen cwd. Data: `GET /fs/recents {paths[]}` (MRU 20). Last row:
**"Browse…"** (`folder.badge.plus`) → Page 2. Empty recents → helper text "No recent folders on
<device> — browse to pick one." + Browse row.

Page 2 — directory browser (daemon-side FS; `/pick-directory` is a Mac-native dialog and REFUSED
remotely — this browser replaces it). Data: `GET /fs/list?cwd=<root>&dir=<rel>&limit=200`
filtered to `type == "directory"`, sorted name-asc, hidden dirs excluded (`includeHidden` unset).
- Root resolution (decision D-12): home = the longest common prefix of the recents paths that
  matches `^/Users/[^/]+` (first recent's first two segments); no recents → `/`.
- Header title = current dir name; back pops one level; rows: `folder` glyph + name; tap
  descends (`dir` accumulates relative path).
- Pinned bottom bar: primary pill **"Use this folder"** → commits `absolutePath` of the current
  dir as cwd, dismisses the sheet, chip updates.
- Errors (permission/does-not-exist): inline caption + back stays enabled. Loading: row spinner.

Chosen path becomes the NewSessionView cwd; it is NOT persisted app-side (the daemon's recents
list learns it after the spawn).

### C10. Device switcher (master 8 · new DeviceSwitcherSheet)

Compact sheet `.eosSheet(detents: [.height(min(72*n+160, 420))])`, `EosSheetHeader("Devices")`.
Rows per paired Mac (Data: `model.devices`, `model.connectionState(for:)`): StateDot (live per
row — background connections stay alive) + label + relay host caption + coral check on
`activeDeviceId`. Tap → `await model.switchDevice(id)`, Haptics.tap, dismiss (drawer chip and
all mirrored state flip instantly). Footer rows, hairline-separated:
- `Pair new Mac…` (`qrcode.viewfinder`) → dismiss → present AddDeviceSheet.
- `Manage devices…` (`gearshape` — the only gear left in the app) → dismiss →
  `sidebar.section = .devices`.

### C11. Devices manage + rename (master 7 · DevicesView edit)

Existing DevicesView layout kept (rows, add, remove-confirm). Additions:
- Row context menu + a trailing `pencil` button: **Rename** → `GlassDialog(title: "Rename
  device", message: "Shown in the sidebar and device switcher.", text: label)` → OK →
  `model.renameDevice(id, newLabel)` — client-side only: mutate `device.label`,
  `deviceStore.upsert(device)`, `reloadDevices()`. No backend call (label lives in the phone's
  UserDefaults metadata index; Keychain secrets untouched). UI reads labels ONLY from
  `model.devices` (never `DeviceConnection.device.label`, which stays stale until reconnect).
- Row context menu keeps Remove.

### C12. Permission banner — spec'd in C3 (component in §A/H). No standalone screen remains;
`PendingListView.swift` and the Home top-right pending chrome button are deleted (master 11).

### C13. Three-dot menu + rename dialog (ref IMG_4432/4433 · master 20)

Conversation header trailing button hosts a native `Menu`:
- **Change model** — two-line label (`Text("Change model"); Text(currentModelDisplay)` — SwiftUI
  renders title+subtitle inside Menu), icon `shuffle` → presents ModelSheet in conversation
  context (C6).
- **Rename** (`pencil`) → `PUT /workers/:id/rename-intent {active:true}`, then `GlassDialog`
  ("Rename session" / "Enter a new name", prefilled current name). OK → `PUT /workers/:id/name
  {name}` (empty string → send `{name: null}` to reset to auto-name); Cancel →
  `rename-intent {active:false}`. Dialog anatomy per IMG_4433: glass card, field capsule,
  Cancel/OK capsules.
- **Archive** (`archivebox`) → `POST /workers/:id/archive`, Haptics.warning, pop to Code list.

No Share (no backend — master 20). Menu order matches IMG_4432 minus Share.

---

## D. Agents tree (master 3/4 · Mac lib/tree.js + sidebar/AgentsTree.jsx)

Lives in `EosRemoteKit/Data/AgentTree.swift` (pure, testable) + row views in
`Views/AgentRows.swift`.

### D1. Build

Port of `buildAgentTree`: nodes from `GET /workers` rows; child ↔ parent via `parent_id`
(missing parent ⇒ root). **Children sorted `started_at` ASC** inside every parent (Mac rule).

### D2. Root comparator (running-first — exact definition)

```
isRunningState(s) = s ∈ {WORKING, SPAWNING, KILLING}
subtreeRunning(n) = isRunningState(n.state) || n.children.contains(where: subtreeRunning)
recencyKey(w)     = max(w.turn_started_at ?? 0, w.started_at)
rootCompare(a, b):
    if subtreeRunning(a) != subtreeRunning(b) → running first
    else → recencyKey(subtree max) DESC        // most recently active first
```

`recencyKey(subtree max)` = max recencyKey over the root and all descendants. KILLING counts as
running (it is orange/active — a session being torn down is still "hot"). Idle/DONE/SUSPENDED/
DRAFT sink. Ties (identical keys) break by `id` desc for stability.

### D3. Row anatomy

**OrchestratorRow** (root, ref IMG_4434 row): 44pt leading rounded-square tile (`surface2`,
radius 12) containing a `folder` glyph (`inkSecondary`) with an 10pt state dot overlaid
bottom-trailing (running green `State.runningDot` / idle gray / KILLING `queuedDot` orange-ish —
uses `EosRunState`); title = `nameOf` in `EosFont.label` SemiBold (`bodySerifEmph` weight —
orchestrators read heavier, Mac `.ag-name.main`); subtitle caption = `cwd` basename + " · N
workers" (N = subtree size − 1, omitted when 0); trailing column: relative time from
`recencyKey` ("2m", "Apr 14") in `caption`/`inkTertiary` + status: attention dot (D4) OR loop
badge OR nothing. Collapse chevron: leading of the children block — tap the tile toggles
collapse when children exist (state in a local `Set<String>`; not persisted).

**WorkerChildRow** (indented 56pt): 8pt state dot + name (`EosFont.label` regular; git role gets
the small branch glyph before the name — Mac `ag-git-badge`) + `(definition)` suffix in
`inkFaint` when `worker_definition` is a specialist (Mac `definitionOf`: nil for orchestrators +
"general-purpose") + trailing: loop badge (`loop` capsule, `State.violetSoft` bg — existing
LoopViews vocabulary) if `loop != nil`, else attention dot if flagged, else lowercase status
label (`running/idle/done/waiting…` from `EosRunState.label`, `captionSmall`/`inkTertiary`).

Tap anywhere on either row → `.conversation(id)`. Rows with pending permission asks in their
subtree show a trailing amber dot + count ("2") chip (`State.waitingSoft` bg) — the phone's
route to the banner (C3).

### D4. Attention dot (master 22 · Mac lib/agentAttention.js port)

`sigOf(w) = "\(tokens_in+tokens_out)|\(tool_calls)|\(cost_usd)"`;
`needsAttention(w) = stopped(w.state ∈ {IDLE, DONE, SUSPENDED}) && lastViewedSig[w.id] != nil
&& lastViewedSig[w.id] != sigOf(w)`. Ledger lives on AppModel (in-memory, per-launch), seeded
on first workers snapshot with current sigs (never flag pre-existing output — Mac rule);
`markViewed(id)` on conversation open AND close. Dot: 8pt `EosColor.attention` circle with
1.5pt `bg` ring.

---

## E. Global safe-area + keyboard rules (master 1/2/17)

1. **Top chrome backdrop**: every top bar (TopChrome on root screens, the conversation header)
   is a `safeAreaInset(edge: .top)` whose background is
   `LinearGradient(colors: [bg, bg.opacity(0.9), bg.opacity(0)], startPoint: .top, endPoint:
   .bottom)` drawn with `.ignoresSafeArea(edges: .top)` and extending 16pt below the bar row —
   content scrolls under and fades out; no hard clip, no opaque band. Buttons stay floating
   glass in one `GlassEffectContainer`.
2. **Bottom composer backdrop**: the bottom `safeAreaInset` (banner + chips + composer stack)
   gets the mirrored gradient (`clear → bg` downward, 24pt overshoot above the stack,
   `.ignoresSafeArea(edges: .bottom)`), so transcript text fades behind the composer instead of
   clipping.
3. **Drawer**: full-height `.ignoresSafeArea()` both edges; its own content applies safe-area
   padding manually (C1).
4. **Keyboard**: every scroll surface behind a composer sets
   `.scrollDismissesKeyboard(.interactively)` AND
   `.simultaneousGesture(TapGesture().onEnded { focused = false })`; the keyboard `Done`
   toolbar button is kept. Composer releases focus on send (existing pattern).
5. Sheets present over the keyboard (system default); GlassDialog raises with keyboard
   avoidance (it is a small centered card — standard `.ignoresSafeArea(.keyboard)` NOT set).

---

## F. API wiring table

Screen → endpoint → fields used. All calls tunnel through `DeviceConnection.control` unless
noted. (R) = already reachable per tiers.ts; (G#) = backend gap, see §G.

| Surface | Call | Request fields | Response fields used |
|---|---|---|---|
| Code list (live) | `GET /workers` (R) | — | WorkerRow: id, name, state, parent_id, is_orchestrator, started_at, turn_started_at, cwd, model, effort, tokens_in/out, tool_calls, cost_usd, loop{status,attempt,maxAttempts,goalSummary}, agent_role, worker_definition, permission_mode |
| Code list (archived) | `GET /workers/archived` (R — matches `/workers/:id` READ pattern; see G3) | — | + archived_at |
| Archive / Restore | `POST /workers/:id/archive` · `/restore` (**G1**) | — | ok |
| Conversation transcript | `GET /workers/:id/events?order/afterId/beforeId/limit` (R) | paging params | event rows (existing pipeline) |
| Send (worker) | `POST /workers/:id/message` (R) | text, clientMsgId, queueWhenBusy:true | — |
| Send (orchestrator) | `POST /orchestrators/:id/message` (R) | same | — |
| Interrupt | `POST /workers/:id/interrupt` (R) | — | — |
| Permission allow/deny | `POST /pending/:id/decision` (R) | decision:"allow"\|"deny" | — |
| Always allow | + `POST /api/policy/rule` (R) | tool, behavior:"allow" | — |
| Pending list (banner source) | `GET /pending` (R) + Store SSE patches | — | id, worker_id, tool_name, input, expires_at |
| Change model / effort | `PUT /workers/:id/model` (R) | model (family alias), effort | — |
| Change mode | `PUT /workers/:id/permission` (R) | mode | — |
| Rename | `PUT /workers/:id/name` (R) | name \| null | — |
| Rename intent | `PUT /workers/:id/rename-intent` (R) | active | — |
| New session create | `POST /orchestrators` (R) | cwd (required), model?, effort?, prompt?, permissionMode?, backendProfile? | id |
| Model sheet | `GET /api/ui-config` (R) | — | modelCatalog[{id,displayName,createdAt,maxInputTokens,effortLevels}], backends[{kind,label,enabled,billing}], backendProfiles[{name,kind,model,label}] |
| Repo picker | `GET /fs/recents` (R) | — | paths[] |
| Directory browser | `GET /fs/list?cwd&dir&limit=200` (R) | cwd, dir | entries[{name,absolutePath,relativePath,type}] |
| Attachment upload | `POST /fs/paste-b64` (**G2 — new route**) | name, dataB64 | path |
| Question answer (existing blocks) | `POST /workers/:id/question-answer` (R) | toolUseId, answers[] | — |
| Rewind (existing, unchanged) | `GET /workers/:id/rewind-targets` + `POST /workers/:id/rewind` (R) | uuid, mode | targets[] |

Live streams (unchanged): WS snapshot/patch/event frames; `agent:delta` thinking, `worker:change`,
`terminal:chunk/done`, `loop:check` already handled in DeviceConnection.

Mac-parity delta shipped NOW (master 22): interrupt, queue-on-busy flag, live thinking, loop
badges, runtime model/effort change, runtime permission change, archived list, attention dot.
LATER (recorded, not spec'd): queue list management UI (GET/DELETE queue), rewind panel UI
(existing long-press path kept as-is), provider runtime switch (PUT /workers/:id/backend),
archived purge, per-profile model browsing (GET /api/backends/:name/models).

---

## G. Backend work list (server-side; implementers of the backend package do this — the iOS
packages must NOT edit these files)

G1. **tiers.ts — required additions** (manager/remote/tiers.ts): the archive pair currently
fails closed to REFUSED (two-segment paths match nothing):
```
R("POST", "/workers/:id/archive", "LOW"),
R("POST", "/workers/:id/restore", "LOW"),
```

G2. **Binary upload lane — new route** `POST /fs/paste-b64`. Root cause: the remote control
tunnel JSON-stringifies bodies and hardcodes `content-type: application/json`
(manager/remote/virtual-dispatch.ts:84 `makeRouteDispatch`), and `ControlFrameSchema.body` is an
opaque JSON string — so `/fs/paste` (raw octet-stream + `x-filename` header) can never be
reached from a phone. Additive fix, no wire-schema change:
- contracts/src/http.ts: `FsPasteB64RequestSchema { name: string, dataB64: string }` →
  `{ path: string }`; ROUTES `fsPasteB64: "/fs/paste-b64"`.
- manager/routes/fs-read.ts: handler decodes base64, enforces the same `PASTE_MAX_BYTES` cap,
  writes `mkdtemp("eos-paste-")/<sanitized name>`, returns `{path}` (mirror of `/fs/paste`).
- tiers.ts: `R("POST", "/fs/paste-b64", "HIGH", true)` (same tier/uiToken as `/fs/paste`).

G3. **tiers.ts — recommended clarity entry** (works today only by coincidence):
`GET /workers/archived` classifies READ because it happens to match the `GET /workers/:id`
pattern (`^/workers/[^/]+$`). Add an explicit `R("GET", "/workers/archived", "READ")` above the
`:id` rule so the intent survives future rule reshuffles. (Optional; iOS works without it.)

G4. **tiers.ts — later, when their features ship** (not needed for this redesign):
`R("DELETE", "/workers/:id/purge", "HIGH")` (archived purge),
`R("GET", "/api/backends/:name/models", "READ")` (per-profile model browsing).

Nothing else server-side: device rename is phone-local (C11); suggestions are static (C4);
attachments ride G2; every other route used is already reachable.

---

## H. File-ownership map

Six packages: P1/P2 = wave 1 (parallel), P3/P4/P5 = wave 2 (parallel), P6 = integration
(strictly serial, after wave 2). **Disjointness rule: every file below appears under exactly one
package; a package may not touch files it does not own.** Wave-1 packages are ADDITIVE ONLY
(plus whitelisted in-place edits that keep existing call sites compiling) so wave 1 builds
green with the legacy screens still present; all deletions happen in wave 2 where the last
consumers die. P6 owns only verification + the explicitly whitelisted dead-symbol sweep.

### P1 — Design system & primitives (wave 1)

Scope: tokens + every new visual primitive. No screen logic, no networking. Everything additive.

| Action | File |
|---|---|
| edit (add tokens only) | `ios/EosRemote/DesignSystem/Colors.swift` (`EosColor.attention`) |
| edit (add constants only) | `ios/EosRemote/DesignSystem/Spacing.swift` (`EosRadius.sheet/menu/banner`, grabber dims) |
| new | `ios/EosRemote/DesignSystem/Motion.swift` |
| new | `ios/EosRemote/DesignSystem/Components/SheetChrome.swift` (`EosSheetHeader`, `.eosSheet`) |
| new | `ios/EosRemote/DesignSystem/Components/SelectRow.swift` |
| new | `ios/EosRemote/DesignSystem/Components/FilterChip.swift` |
| new | `ios/EosRemote/DesignSystem/Components/ModePill.swift` |
| new | `ios/EosRemote/DesignSystem/Components/ChatComposer.swift` |
| new | `ios/EosRemote/DesignSystem/Components/AttachmentChipRow.swift` |
| new | `ios/EosRemote/DesignSystem/Components/PermissionBanner.swift` |
| new | `ios/EosRemote/DesignSystem/Components/GlassDialog.swift` |

Published component APIs (the cross-package contract; P3/P4/P5 consume, P1 must not change
signatures after wave 1):

```swift
struct EosSheetHeader: View { init(_ title: String, back: Bool = false, onClose: @escaping () -> Void) }
extension View { func eosSheet(detents: Set<PresentationDetent>) -> some View }

struct SelectRow: View {
    init(icon: String? = nil, iconTint: Color = EosColor.inkSecondary,
         title: String, subtitle: String? = nil, selected: Bool, action: @escaping () -> Void)
}
struct FilterChip: View { init(_ label: String, count: Int, selected: Bool, action: @escaping () -> Void) }
struct ModePill: View { init(mode: PermissionModeUI, action: @escaping () -> Void) }
enum PermissionModeUI: String { case acceptEdits, bypassPermissions   // display: "Accept edits" / "Full Access"
    var label: String; var icon: String; var subtitle: String }

struct ChatComposer: View {
    init(text: Binding<String>, placeholder: String,
         mode: PermissionModeUI, onModeTap: @escaping () -> Void,
         attachMenu: @escaping () -> AnyView,          // the ⊕ button's Menu content (P5 supplies)
         chips: [AttachmentChipVM], onRemoveChip: @escaping (String) -> Void,
         onRetryChip: @escaping (String) -> Void,
         trailing: ComposerAction,                     // .send(enabled:Bool, () -> Void) | .interrupt(() -> Void)
         focused: FocusState<Bool>.Binding)
}
enum ComposerAction { case send(enabled: Bool, () -> Void), interrupt(() -> Void) }
struct AttachmentChipVM: Identifiable { let id, label: String; let kind: AttachmentKind
    let status: ChipStatus; let thumbnail: UIImage? }   // ChipStatus: uploading|ready|error
enum AttachmentKind: String { case image, file }

struct PermissionBanner: View {
    init(pending: [Pending], nameFor: @escaping (String) -> String,
         onAllow: @escaping (Pending) -> Void, onAlwaysAllow: @escaping (Pending) -> Void,
         onDeny: @escaping (Pending) -> Void)
}
struct GlassDialog: View {
    init(title: String, message: String, text: Binding<String>,
         confirmLabel: String = "OK", onCancel: @escaping () -> Void, onConfirm: @escaping () -> Void)
}
```

### P2 — Data layer & endpoints (wave 1)

Scope: models, tree/attention logic, all new DeviceConnection/AppModel surface, attachment
state machine. Additive; legacy methods (`spawnWorker`, `kill`) are left in place so wave 1
compiles — P6 sweeps them.

| Action | File |
|---|---|
| edit (add computed fields) | `ios/EosRemoteKit/Models/Domain.swift` |
| new | `ios/EosRemoteKit/Models/UiConfig.swift` (UiConfig/CatalogModel/BackendProfile decode + ModelCatalog + efforts, §A4) |
| new | `ios/EosRemoteKit/Data/AgentTree.swift` (AgentNode, buildTree, rootCompare, subtreeRunning, recencyKey, sigOf/needsAttention pure fns, §D) |
| new | `ios/EosRemoteKit/Data/AttachmentTokens.swift` (makeLabel, buildAttachmentSuffix, parseAttachmentMessage ports) |
| edit (add methods; fix internal sort only) | `ios/EosRemote/App/DeviceConnection.swift` |
| edit (add forwarders + published state) | `ios/EosRemote/App/AppModel.swift` |
| new | `ios/EosRemote/App/AttachmentDraftModel.swift` |
| new | `ios/EosRemoteKitTests/AgentTreeTests.swift` |
| new | `ios/EosRemoteKitTests/AttachmentTokensTests.swift` |
| new | `ios/EosRemoteKitTests/UiConfigTests.swift` |

Domain.swift additions (computed over `raw`, all optional-safe): `startedAt: Double`,
`turnStartedAt: Double?`, `endedAt: Double?`, `archivedAt: Double?`, `cwd: String?`,
`permissionMode: String?`, `tokensIn/tokensOut: Int?`, `toolCalls: Int?`,
`workerDefinition: String?`, `agentRole: String?`, `recencyKey: Double`; on `Pending`:
`toolName` (alias of existing `tool`), `inputRaw: String?` (raw["input"]).

DeviceConnection new method signatures (the P3/P4/P5 contract):

```swift
func fetchUiConfig() async -> UiConfig?                       // GET /api/ui-config
func fetchArchived() async -> [Worker]                        // GET /workers/archived
func archive(_ id: String) async -> Bool                      // POST /workers/:id/archive
func restore(_ id: String) async -> Bool                      // POST /workers/:id/restore
func setModel(_ id: String, model: String, effort: String) async -> Bool   // PUT /workers/:id/model
func setPermissionMode(_ id: String, mode: String) async -> Bool           // PUT /workers/:id/permission {mode}
func setName(_ id: String, name: String?) async -> Bool       // PUT /workers/:id/name {name|null}
func renameIntent(_ id: String, active: Bool) async           // PUT /workers/:id/rename-intent
func spawnOrchestrator(cwd: String, model: String?, effort: String?, prompt: String,
                       permissionMode: String, backendProfile: String?) async -> String?  // POST /orchestrators → id
func fetchRecents() async -> [String]                         // GET /fs/recents
func listDirectories(cwd: String, dir: String?) async -> [FsDirEntry]      // GET /fs/list (directories only)
func uploadAttachment(name: String, data: Data) async -> String?           // POST /fs/paste-b64 → path
// sendMessage gains routing: is_orchestrator ⇒ POST /orchestrators/:id/message, else /workers/:id/message
```

AppModel additions: forwarders for all of the above; `@Published var uiConfig: UiConfig?`
(fetched on connect + device switch); `@Published var archived: [Worker]`;
attention ledger `markViewed(_ id: String)` / `needsAttention(_ w: Worker) -> Bool` (seeding per
D4); `func renameDevice(_ id: String, label: String)` (DeviceStore upsert path, C11).
`FsDirEntry { name, absolutePath, relativePath }`.
`AttachmentDraftModel`: `@Published items: [AttachmentChipVM]`,
`add(name: String, data: Data, kind: AttachmentKind, thumbnail: UIImage?)` (normalize → upload →
status flips), `remove(label:)`, `retry(label:)`, `suffix() -> String`, `var allReady: Bool`,
`func clear()`.

### P3 — Shell, drawer, devices (wave 2)

| Action | File |
|---|---|
| edit (rewrite root content + routes) | `ios/EosRemote/App/RootView.swift` |
| edit (full-height drawer) | `ios/EosRemote/App/SidebarContainer.swift` (incl. `SidebarSection` → `.code/.devices`) |
| new | `ios/EosRemote/App/DrawerView.swift` |
| new | `ios/EosRemote/App/DeviceSwitcherSheet.swift` |
| edit (gradient backdrop, title slot) | `ios/EosRemote/App/TopChrome.swift` |
| edit (rename UI) | `ios/EosRemote/Views/DevicesView.swift` |
| delete | `ios/EosRemote/App/SidebarView.swift` |
| delete | `ios/EosRemote/App/AccountLabel.swift` |
| delete | `ios/EosRemote/Views/SettingsView.swift` |
| delete | `ios/EosRemote/DesignSystem/Components/Avatar.swift` |

TopChrome contract change (consumed by P4's CodeListView): `eosTopChrome(title: String? = nil,
trailing:)` — optional centered title; gradient backdrop per §E1 baked in.

### P4 — Code list + conversation (wave 2)

| Action | File |
|---|---|
| new | `ios/EosRemote/Views/CodeListView.swift` |
| new | `ios/EosRemote/Views/AgentRows.swift` (OrchestratorRow, WorkerChildRow) |
| edit (rewrite per C3) | `ios/EosRemote/Views/WorkerDetailView.swift` |
| new | `ios/EosRemote/Views/SessionMenu.swift` (three-dot content + rename-dialog wiring) |
| edit (attachment-suffix chips) | `ios/EosRemote/Views/Messages/UserMessageView.swift` |
| delete | `ios/EosRemote/Views/HomeView.swift` |
| delete | `ios/EosRemote/Views/FleetView.swift` |
| delete | `ios/EosRemote/Views/PendingListView.swift` |
| delete | `ios/EosRemote/Views/AskUserSheet.swift` |
| delete | `ios/EosRemote/DesignSystem/Components/Composer.swift` |
| delete | `ios/EosRemote/DesignSystem/Components/ModelPill.swift` |

Consumes from P5 (same wave — interfaces fixed here): `ModelSheet(context:)`, `ModeSheet(...)`,
`AttachmentMenu(draft:)` (see P5 contract).

### P5 — New session, pickers, attachments UI (wave 2)

| Action | File |
|---|---|
| new | `ios/EosRemote/Views/NewSessionView.swift` |
| new | `ios/EosRemote/Views/Sheets/ModelSheet.swift` |
| new | `ios/EosRemote/Views/Sheets/ModeSheet.swift` |
| new | `ios/EosRemote/Views/Sheets/RepoPickerSheet.swift` (incl. DirectoryBrowser page) |
| new | `ios/EosRemote/Views/Attachments/AttachmentMenu.swift` (Menu content + camera/photos/file pickers glue) |
| delete | `ios/EosRemote/Views/SpawnSheet.swift` |
| delete | `ios/EosRemote/Views/ModelPickerSheet.swift` |

Published APIs (consumed by P4):

```swift
enum ModelSheetContext {
    case draft(model: Binding<String>, effort: Binding<String>, backendProfile: Binding<String?>)
    case worker(Worker)          // commits via model.setModel(id:model:effort:)
}
struct ModelSheet: View { init(context: ModelSheetContext) }     // presents per C6
struct ModeSheet: View { init(current: PermissionModeUI, onPick: @escaping (PermissionModeUI) -> Void) }
struct AttachmentMenu {                                          // returns the ⊕ Menu content
    static func content(draft: AttachmentDraftModel,
                        presentCamera: Binding<Bool>, presentPhotos: Binding<Bool>,
                        presentFiles: Binding<Bool>) -> AnyView
    // plus modifier: func attachmentPickers(draft:camera:photos:files:) -> some View
}
struct RepoPickerSheet: View { init(current: String?, onPick: @escaping (String) -> Void) }
```

### P6 — Integration & verify (serial, after wave 2)

Owns no feature files. Mandate:
1. `cd ios && xcodegen` (project.yml is glob-based — new/deleted files need no yml edit; owns
   `ios/project.yml` in case a stray reference appears).
2. Build: `xcodebuild -project EosRemote.xcodeproj -scheme EosRemote -destination
   'generic/platform=iOS Simulator' build` (per `ios/BUILD.md`).
3. Tests: `xcodebuild test -scheme EosRemoteKit -destination 'platform=iOS Simulator,name=iPhone 16'`.
4. Dead-symbol sweep — WHITELIST ONLY (these become unreferenced when wave 2 lands):
   `DeviceConnection.spawnWorker`, `AppModel.spawnWorker`, `DeviceConnection.kill`,
   `AppModel.kill` (verify zero references first; if still referenced, leave and report).
5. Fix cross-package compile seams (signature typos between the contracts above) — smallest
   possible diffs, reported per file.
6. Update `ios/BUILD.md` screen inventory if it names deleted views.

Backend package (repo-side, not an iOS package — can run in wave 1 parallel):
`contracts/src/http.ts` + `manager/routes/fs-read.ts` + `manager/remote/tiers.ts` per §G1/G2/G3
plus a tiers test entry (manager test suite). iOS attachment upload + archive/restore degrade
gracefully (error chip / error toast) until it lands.

Disjointness check: every path above appears exactly once. Shared surfaces resolved: tokens →
P1; DeviceConnection/AppModel → P2 (P6 sweep whitelisted, serial so no conflict);
TopChrome/SidebarContainer/RootView → P3; legacy composer + ModelPill deletions → P4 (their last
consumer); SpawnSheet/ModelPickerSheet deletions → P5 (replaced by its screens).

---

## Decisions (deviations + ambiguity calls, recorded)

- **D-1 Accent**: `EosColor.coral` keeps value `#6EA4E8` — identical to the Mac dark-theme
  `--accent`. The directive's word "coral" refers to the brand token name; no color change.
- **D-2 Filter chips**: reference's "Completed" → **Running** (Eos sessions idle rather than
  complete; running-first is the fleet-useful filter). Chips: All / Running / Archived.
- **D-3 Month sections** (IMG_4434) apply ONLY to the Archived filter — the live list is owned
  by the running-first sort and month headers would fight it.
- **D-4 KILLING** counts as running in the sort comparator (active/orange).
- **D-5 Recency** = `max(turn_started_at ?? 0, started_at)`, subtree-max for roots.
- **D-6 Suggestions** (IMG_4435) are 3 static strings — no suggestions backend exists; they
  fill the empty new-session screen and insert text only.
- **D-7 "Default" cloud chip** (IMG_4435) maps to the active-device chip (tap → device
  switcher) — the paired Mac is Eos's "environment".
- **D-8 Composer mic** and the reference's second `+` above the input row are dropped
  (master 12; one attach entry).
- **D-9 Permission banner scope**: open agent + its descendants (Mac filters to the exact
  worker; the phone has no persistent tree next to the transcript, and the orchestrator chat is
  the operator's seat). Banner names the asking worker, preserving Mac anatomy.
- **D-10 Send route split**: orchestrator rows message via `POST /orchestrators/:id/message`,
  plain workers via `POST /workers/:id/message` (both exist, both LOW; Mac client exposes both).
- **D-11 Attachment caps**: images downscaled to ≤2048px JPEG q0.8; any payload > 3 MB rejected
  with a toast (relay envelope hard-caps 5 MB; base64 inflates 4/3).
- **D-12 Directory-browser root**: derived `/Users/<name>` prefix from the recents paths;
  `/` fallback. (`GET /fs/list` requires an absolute `cwd`; `/pick-directory` is REFUSED
  remotely by design.)
- **D-13 No kill/purge on phone**: swipe-Archive replaces swipe-Kill; permanent deletion stays a
  Mac affordance this phase. `kill` methods become dead code → P6 sweep.
- **D-14 Mode change sends `{mode}` without `cascade`** — exactly what the Mac AcceptPopover
  does.
- **D-15 Interrupt relocation**: from top chrome into the composer trailing button (busy +
  empty field ⇒ stop glyph), matching the Mac composer's stop affordance; the conversation
  header trailing slot is now the three-dot menu.
- **D-16 Ultracode** stays in the effort list (Mac parity; it's a session feature layered on
  xhigh, accepted by the same PUT/spawn fields).
- **D-17 Rename empty input** resets to auto-name (`{name: null}` + `name_source` machinery
  daemon-side), mirroring Mac RenameInput semantics.
- **D-18 Drawer is opaque** `bg` (reference drawer is opaque; glass panel dropped), full-height,
  85%/360pt width.
- **D-19 eos://pending deep link** now lands on the Code list (banners replaced the pending
  screen).
- **D-20 uploads via new `/fs/paste-b64`** rather than extending the frozen ControlFrame wire
  schema with binary/headers — additive route, zero risk to existing joined-device clients.

## Master fix list → resolution map

| # | Resolved in |
|---|---|
| 1 top/bottom safe-area artifacts | §E1/E2 |
| 2 drawer small/inset | §C1, D-18 |
| 3 nested tree, orchestrator distinct | §D1/D3 |
| 4 running first | §D2 |
| 5 remove spawn-worker UI | §B3, P4/P5 deletes, D-13 |
| 6 new-session lazy POST /orchestrators | §C4 |
| 7 device rename client-side | §C11 |
| 8 device chip → switcher popup | §C1.2, C10 |
| 9 delete SettingsView | §B3, P3 |
| 10 Fleet→Code | §B1, C1.3, C2 title |
| 11 permission banner replaces pending UI | §C3, C12, D-9 |
| 12 remove mic/voice | §C3/C4 composer, D-8 |
| 13 remove sidebar avatar | §C1.5, P3 delete |
| 14 full model picker from /api/ui-config | §A4, C6 |
| 15 attachment menu | §C8 |
| 16 upload pipeline + suffix format | §C8, G2, D-11 |
| 17 keyboard dismiss | §E4 |
| 18 two-mode sheet | §C7 |
| 19 Code list mix of 4434/4428 | §C2, D-2/D-3 |
| 20 three-dot menu + rename + archive | §C13 |
| 21 repo picker + fs/list browser | §C9, D-12 |
| 22 parity delta now/later | §F (bottom), D-15 |
| 23 sheet/dialog anatomy + motion + haptics | §A2/A3/A5 |
