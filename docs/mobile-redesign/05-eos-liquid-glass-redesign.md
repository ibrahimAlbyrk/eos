# 05 — Eos Liquid Glass Redesign (v2, dark dawn-star)

**Status:** Master implementation contract. Copy-implementable. No code here ships verbatim until built + reviewed, but every value, file, and structural change is exact enough to build from directly.
**Scope:** A top-to-bottom v2 redesign of the native iOS app at `ios/EosRemote/`. v1 cloned the Claude-mobile "warm paper + serif + coral" look (doc 02). v2 gives Eos its **own** identity: **dark, Liquid Glass, cornflower-blue dawn-star** — matching the Eos Mac dashboard (`app/ui`), mobile-adapted.
**Targets:** iOS 26+ (test iOS 27), Swift 6, SwiftUI, XcodeGen (`ios/project.yml`), Xcode 26 SDK.
**This is a re-theme + restructure, NOT a rewrite.** The transport, `AppModel`/`DeviceConnection`, `DeviceStore`, the whole message-rendering subsystem (doc 03, already built under `ios/EosRemote/Views/Messages/`), and most primitives stay. What changes: the **token values** (paper→dark, coral→cornflower, New York→Plus Jakarta Sans), the **glass material** on chrome, the **flat fleet list → a hierarchy tree**, the **new-session flow**, **pending as an inline banner**, the **in-place device switcher**, **settings as a footer**, and **four shell bug fixes**.

**Supersedes / revises the earlier docs:**
- **Doc 02** — its *palette, typography, and "warm paper" aesthetic are REPLACED* by §1 here. Its *file structure, component inventory, and screen list remain the base* (they are already built). Its `.preferredColorScheme(.light)` light-lock is **dropped** (v2 is dark-only; §1.4).
- **Doc 03** — the transcript renderers **stay structurally 1:1**; they are **re-themed** paper/serif → dark automatically via the token swap (§1.6). Only a handful of manual touch-ups (§1.6.2) are needed.
- **Doc 04** — the **authority** for the material + structural system. Its navigation-vs-content master rule (glass = chrome only; content stays opaque) and its safe-area / keyboard fixes are applied throughout (§2, §3, §4).

> **One-sentence mental model.** Dark technical cockpit: opaque near-black content (transcript, tree rows, cards), quietly glassy floating chrome (top bar, composer, "+" FAB, drawer, sheets, device list, pending banner), and cornflower blue used *only for meaning* — the dawn-star mark, the active/primary action, links. Colour is earned, never decorative.

---

## 0. What exists today (grounding — build ON this, don't recreate)

The app is far past doc 02's "restyle sketch" stage. The whole design system, the shell drawer, and the entire doc-03 message renderer are **built and token-driven**. v2 is overwhelmingly a **values + structure** change, and because ~everything reads `EosColor`/`EosFont`, most of the visual shift lands by editing **two files**.

| Area | Files (current) | v2 action |
|---|---|---|
| **Tokens** | `DesignSystem/Colors.swift`, `Typography.swift`, `Theme.swift`, `Spacing.swift`, `Sunburst.swift` | **Swap values** (§1). `Colors`+`Typography` carry ~all of the shift. `Spacing`/radii unchanged. `Theme` drops the light-lock. `Sunburst` recolored to the blue dawn-star gradient. |
| **Primitives** | `DesignSystem/Components/*` (`CircularIconButton`, `PillButton`, `ModelPill`, `Composer`, `SidebarRow`, `Avatar`, `StateDot`, `SectionText`) | Re-theme via tokens (automatic). `Composer`/`CircularIconButton`/`PillButton` gain glass (§2, §3). `Avatar` → optional; settings footer replaces its footer role (§3.6). |
| **Shell** | `App/RootView.swift`, `SidebarContainer.swift`, `SidebarView.swift`, `TopChrome.swift` | Restructure: glass chrome + safe-area fix (§3.1, bug 1), glass drawer + corner fix (§3.1, bug 2), remove Pending/Devices/Settings nav rows → settings footer + inline device switcher (§3.6/§3.5), device-chip connection dot (bug 4). |
| **Home / fleet** | `Views/HomeView.swift`, `FleetView.swift` (`WorkerRowNew`) | Replace the flat `List` sections with the **hierarchy tree** (§3.3). Home hero → new-session entry (§3.2). |
| **Transcript** | `Views/WorkerDetailView.swift`, `Views/Messages/**` (dispatcher `MessageGalleryView` + ~40 tool/block views, all built) | Keep structurally. Re-theme via tokens (§1.6). Add the pending banner above the composer (§3.4). Keyboard fixes (bug 3). |
| **Devices / settings** | `Views/DevicesView.swift`, `SettingsView.swift`, `Pairing/*` | `DevicesView` demoted from nav; the sidebar chip opens an **in-place list** (§3.5). `SettingsView` reached from the **footer** (§3.6). |
| **Data / transport** | `App/AppModel.swift`, `App/DeviceConnection.swift`, `EosRemoteKit/**` | **Unchanged, except one addition:** `spawnOrchestrator` (POST `/orchestrators`) — the app today only has `spawnWorker` (POST `/workers`). Required for the new-session flow (§3.2, §5 step 4). |

**Authoritative data facts (verified in-repo — the redesign relies on these):**
- `Worker` (`EosRemoteKit/Models/Domain.swift`) already exposes `isOrchestrator` (`is_orchestrator`), `parentId` (`parent_id`), `state`, `model`, `effort`, `loop` (`WorkerLoop`), `backendKind`. **The tree can be built today** with no data change.
- `AppModel` exposes `workers`, `orchestrators`/`plainWorkers`, `pending: [Pending]`, `devices`/`activeDeviceId`/`activeDevice`, `connectionState(for:)`, `connected`/`connecting`, and forwards `spawnWorker(body:)`, `sendMessage`, `interrupt`, `kill`, `approve(pendingId:allow:)`, `openWorker`.
- **`Pending`** exposes `id`, `workerId`, `tool`, `summary`, `ttl`. **`approve(pendingId:allow:)`** covers Allow-once (allow:true) and Deny (allow:false). **"Always allow" is NOT wired on iOS** — the Mac calls `addPolicyRule(tool, "allow")`; iOS has no equivalent (§3.4 open decision + §5 step 5).
- **No `spawnOrchestrator` on iOS.** Mac `POST /orchestrators` body = `{ name?, cwd (required, min 1), model?, effort?, prompt?, permissionMode?, backendKind?, backendProfile? }`. `cwd` is required — the new-session composer must supply one (§3.2).
- Mac `statusFromState` (`app/ui/src/lib/format.js`) → the canonical status vocabulary (§3.3.1). iOS `EosRunState.from` currently maps a *subset*; v2 aligns it (§1.5).

---

## 1. Design tokens — the value swap

The single highest-leverage change. Edit `Colors.swift` + `Typography.swift` and ~80% of the app re-themes on the next build, because every view already routes color/type through `EosColor`/`EosFont`. Keep the **enum-namespace-of-`static let`s** shape, the `Color(hex:)` init, the `EosRunState` resolver location, and the `EosColor.State` nesting — only the **values** change (plus the additions called out).

### 1.1 Palette — dark (`Colors.swift`, full replacement of the body)

Values are the Eos Mac dashboard's dark tokens (`app/ui` CSS vars), verified against the brief. All opaque unless noted.

| Token | Hex | Was (paper) | Role |
|---|---|---|---|
| `bg` | `#1A1A1A` | `#F5F4EF` | App background — near-black. Base everywhere; bleeds under the notch/home-indicator. |
| `bgSunken` | `#151515` | `#EFEEE7` | Recessed wells / scrim base (a hair below `bg`). |
| `surface` | `#1F1F1F` | `#FBFAF7` | Cards, tool-group / terminal fill, opaque row/detail backgrounds. |
| `surface2` (new) | `#252525` | — | Inline code, chip fills, nested card fill (Mac `--surface-2`). |
| `surface3` (new) | `#2C2C2C` | — | Table header, pressed/agent-card-hover, popover pop (Mac `--surface-3`). |
| `surfaceHi` | `#2C2C2C` | `#FFFFFF` | Pressed/active surface (alias of `surface3`; kept for existing call sites). |
| `ink` | `#EBEBEB` | `#1F1E1C` | Primary text (Mac `--fg`). |
| `inkSecondary` | `#C4C4C4` | `#6B6862` | Secondary text, tool verbs, meta (between Mac `--fg` and `--fg-dim` — see note). |
| `inkTertiary` | `#8A8A8A` | `#9C988F` | Placeholders, arg hints, timestamps, list markers (Mac `--fg-dim`). |
| `inkFaint` (new) | `#5A5A5A` | — | Faintest — disabled, spacer glyphs (Mac `--fg-faint`). |
| `hairline` | `#262626` | `#E4E2DA` | Card borders, separators, composer/pill outline (Mac `--border`). |
| `hairlineStrong` (new) | `#353535` | — | Emphasized borders, focused field (Mac `--border-strong`). |
| `coral` → **keep the NAME, blue VALUE** `#6EA4E8` | `#D97757` | **Accent.** Dawn-star, active nav/selection, links, primary-action tint, focus. Cornflower. |
| `coralPressed` → `#8AB9F0` | `#C25E3E` | Accent hover/pressed (Mac accent-hover; *lighter* on dark). |
| `coralWash` → `#212B35` | `#F3E4DC` | Accent-tinted fill (selected row, user-message wash) — a desaturated blue-slate, not a bright tint. |
| `onAccent` (new) | `#0A0A0A` | — | Text/glyph ON the accent fill (dark, per brief `on-accent`). |
| `onDark` | `#EBEBEB` | `#F7F6F2` | Text on the (now rarely used) solid dark pill — matches `ink`. |
| `black` | `#0A0A0A` | `#111110` | Deepest fill (FAB/pill base when a solid is needed). |
| `danger` | `#D97670` | `#C0392B` | Destructive action (Kill, Deny) — aligns to the state-failed red. |
| `focusRing` | `coral @ 45%` | `coral @ 40%` | Keyboard/VoiceOver focus outline (now blue). |

> **Naming decision (do this, don't rename globally).** Keep the token **name `coral`** even though the value is now cornflower blue, and keep `coralWash`/`coralPressed`. Renaming to `accent`/`accentWash` touches ~40 call sites across the built renderer for zero behavior gain — a pure churn diff that fights the "surgical changes" rule. Leave a one-line comment at the top of `Colors.swift`: `// NOTE: `coral` is the accent token; its v2 value is cornflower blue #6EA4E8 (dawn-star), not coral. Name kept to avoid a 40-call-site rename.` **New** tokens (`surface2/3`, `inkFaint`, `hairlineStrong`, `onAccent`) get their real names.

> **Note on `inkSecondary`.** The Mac uses `--fg-dim #8a8a8a` for tool verbs and `--fg #ebebeb` for primary. The brief gives a mid tier `#c4c4c4`. Use `#c4c4c4` for `inkSecondary` (secondary UI text, worker-row meta) and `#8a8a8a` for `inkTertiary` (the doc-03 "tool verb / arg hint" tier). This keeps doc 03's three-tier text mapping (`fg`/`fg-dim`/`fg-faint` → `ink`/`inkSecondary`/`inkTertiary`) intact; verbs land on `inkTertiary`, which reads correctly on dark.

**State colors** (Mac `--ok/--warn/--err/--violet/--queued` + the queued-bg). Replace the `EosColor.State` body. Each keeps a `Dot` (saturated) + `Soft` (low-alpha wash) pair; on dark the "soft" is a **dark tinted fill**, not a pastel:

| State | `…Dot` | `…Soft` | Applies to |
|---|---|---|---|
| `running` | `#67C084` (green) | `#1C2A22` (green @ ~dark) | `WORKING`, `SPAWNING` |
| `idle` | `#8A8A8A` (gray) | `#242424` | `IDLE`, `ENDING`, `DONE`, `SUSPENDED`, `DRAFT` |
| `failed` | `#D97670` (red) | `#2E1F1E` | `FAILED`, `ERROR` |
| `waiting` | `#D4A55A` (amber) | `#2B2417` | `WAITING`, `INPUT` |
| `info` | `#6EA4E8` (cornflower) | `#212B35` | default / unknown |
| `violet` (new) | `#C8A2FF` | `#241E33` | reserved (loop/peer accents, doc 03) |
| `queued` (new) | `#0099FF` | `#212B35` | queued/optimistic pills (Mac `--queued` / `--queued-bg #212b35`) |

> `…Soft` values on dark are computed as the dot hue over `#1a1a1a` at low alpha; the hexes above are the flattened result. If you prefer, define them as `Color(hex: dotHex, alpha: 0.14)` layered on `bg` — but literal hexes render one flat fill (cheaper, and matches how the Mac's `color-mix` bakes). Either is fine; pick literals for grep-ability.

**`Color(hex:)`** and the `EosRunState` struct location are unchanged. Update `EosRunState.from` to the full vocabulary (§1.5).

### 1.2 The `Sunburst` → dawn-star recolor (`Sunburst.swift`)

The current `Sunburst` **shape** (8 rounded-capsule spokes, star polygon, rounded tips) already **matches the dawn-star geometry** in `assets/eos-banner-aurora-dark.svg` (`#spokes` = 8 `rect`s, `rx=12`, rotated in 45° steps). **Keep the shape; change the fill from a flat `coral` to the radial gradient + halo.** The SVG's exact stops:

- **Star fill** (`#starFill`, radial, center→edge): `#ffffff` @0 → `#e8f1ff` @0.2 → `#a9cdf6` @0.5 → `#5f93dd` @0.8 → `#3f6fb5` @1.0.
- **Halo** (`#halo`, radial, behind, larger): `#6ea4e8` @0 alpha 0.5 → @0.45 alpha 0.13 → @1 alpha 0.
- **Core** (`#core`, radial, small, on top): white → `#6ea4e8` @0.5 alpha 0.55 → transparent.

**Swift shape:** apply the gradient as a `fill` and stack the halo behind:

```swift
// Dawn-star mark — the Sunburst shape filled with the SVG's radial star gradient + a soft halo.
struct DawnStar: View {
    var size: CGFloat = 56
    private static let starStops: [Gradient.Stop] = [
        .init(color: Color(hex: 0xFFFFFF), location: 0.0),
        .init(color: Color(hex: 0xE8F1FF), location: 0.2),
        .init(color: Color(hex: 0xA9CDF6), location: 0.5),
        .init(color: Color(hex: 0x5F93DD), location: 0.8),
        .init(color: Color(hex: 0x3F6FB5), location: 1.0),
    ]
    var body: some View {
        ZStack {
            // Halo: cornflower glow, ~1.7× the mark, behind.
            Circle()
                .fill(RadialGradient(colors: [Color(hex: 0x6EA4E8).opacity(0.5),
                                              Color(hex: 0x6EA4E8).opacity(0.13),
                                              Color(hex: 0x6EA4E8).opacity(0)],
                                     center: .center, startRadius: 0, endRadius: size * 0.85))
                .frame(width: size * 1.7, height: size * 1.7)
                .accessibilityHidden(true)
            Sunburst(spokes: 8)
                .fill(RadialGradient(stops: Self.starStops, center: .center,
                                     startRadius: 0, endRadius: size * 0.5))
                .frame(width: size, height: size)
        }
        .accessibilityHidden(true)
    }
}
```

- **Keep `Sunburst: Shape` as-is** (it's used by the spark animation in doc 03 §6.2 too). Add `DawnStar` as the *composed, gradient-filled* mark. Replace the two `Sunburst().fill(EosColor.coral)` call sites (Home hero 56pt, `TranscriptFoot` 13pt) with `DawnStar(size:)`. The tiny 13pt foot instance may **skip the halo** (drop the halo `Circle` when `size < 20`) to avoid a fuzzy glow at caption scale — draw the gradient star only.
- **The AppIcon is already this mark** — no asset change.
- The doc-03 processing **spark** keeps using the bare `Sunburst` recolored to `coral` (now blue), consistent with the mark.

### 1.3 Typography — bundle Plus Jakarta Sans, drop New York (`Typography.swift`)

v1's serif prose (New York via `design: .serif`) is the Claude look and **goes away**. Eos's wordmark and prose are **Plus Jakarta Sans** (PJS); code stays **JetBrains Mono** (already bundled). Both are OFL/free.

**Bundle PJS:** drop `PlusJakartaSans-*.ttf` (Regular, Medium, SemiBold, Bold, and Italic if prose italics are wanted) into `ios/EosRemote/Resources/Fonts/` (where JetBrains Mono already lives). Register in `Info.plist` `UIAppFonts`. XcodeGen globs the folder — no `project.yml` target-list edit beyond confirming the font files are picked up.

**Rebind every role from `design: .serif`/`.default` to PJS via `Font.custom(_:size:relativeTo:)`** so Dynamic Type still scales (the `relativeTo:` text style is what keeps scaling). Point sizes are the `.large` reference rendering; keep them matched to the old text-style sizes so layouts don't shift.

```swift
// Type roles (v2). Plus Jakarta Sans for UI + prose (drop New York serif); JetBrains Mono for code.
// Every role uses Font.custom(..., relativeTo:) so Dynamic Type scales. `display` still takes -0.4
// tracking at the call site. If a .ttf fails to register, Font.custom falls back to the system font.
enum EosFont {
    // display / headings — PJS, tight, the wordmark + hero + card headings
    static let display       = Font.custom("PlusJakartaSans-Bold",     size: 32, relativeTo: .largeTitle)
    static let titleSerif    = Font.custom("PlusJakartaSans-SemiBold", size: 22, relativeTo: .title2)   // name kept; no longer serif
    static let heading       = Font.custom("PlusJakartaSans-SemiBold", size: 20, relativeTo: .title3)
    // prose — PJS (was bodySerif); this is assistant transcript body
    static let bodySerif     = Font.custom("PlusJakartaSans-Regular",  size: 16, relativeTo: .body)      // name kept; PJS prose
    static let bodySerifEmph = Font.custom("PlusJakartaSans-SemiBold", size: 16, relativeTo: .body)
    // UI labels / body / captions — PJS
    static let label         = Font.custom("PlusJakartaSans-Medium",   size: 15, relativeTo: .subheadline)
    static let labelStrong   = Font.custom("PlusJakartaSans-SemiBold", size: 17, relativeTo: .headline)
    static let body          = Font.custom("PlusJakartaSans-Regular",  size: 16, relativeTo: .body)
    static let caption       = Font.custom("PlusJakartaSans-Regular",  size: 13, relativeTo: .footnote)
    static let captionSmall  = Font.custom("PlusJakartaSans-Regular",  size: 11, relativeTo: .caption2)
    // meta mono (ids/cost) — keep SF Mono; code — keep JetBrains Mono (doc 03 §5.4, already bundled)
    static let mono          = Font.system(.footnote, design: .monospaced)
    static let code          = Font.custom("JetBrainsMono-Regular", size: 13, relativeTo: .footnote)
    static let codeSmall     = Font.custom("JetBrainsMono-Regular", size: 12, relativeTo: .caption)

    static var codeFontIsJetBrains: Bool { UIFont(name: "JetBrainsMono-Regular", size: 13) != nil }
    static var uiFontIsJakarta: Bool { UIFont(name: "PlusJakartaSans-Regular", size: 13) != nil }   // DEBUG fallback flag
}
```

> **Names kept, meaning changed (same rationale as `coral`).** `titleSerif`, `bodySerif`, `bodySerifEmph` are referenced across the built renderer (doc 03 headings/prose). Repointing their *values* to PJS re-themes prose everywhere with **zero call-site edits**; renaming them `title`/`prose`/`proseEmph` is a churn-only diff. Keep the names; add a top-of-file comment that "Serif" is historical — the value is Plus Jakarta Sans. (If the team prefers clean names, do the rename as a *separate* mechanical commit, not mixed into the re-theme.)

**Wordmark:** "eos" lowercase, `PlusJakartaSans-Bold`, tight tracking (`-0.5`). The current `SidebarView` renders `Text("Eos").font(.titleSerif)` — change the string to `"eos"` and add `.tracking(-0.5)` (§3.1).

### 1.4 Theme — drop the light-lock, dark-only (`Theme.swift`)

```swift
extension View {
    /// Root styling (v2): dark background, cornflower accent, DARK-ONLY.
    func eosTheme() -> some View {
        self
            .tint(EosColor.coral)                       // system controls, links, focus (now blue)
            .background(EosColor.bg.ignoresSafeArea())  // dark bleeds under the notch (bug 1)
            .environment(\.eosTheme, EosTheme())
            .preferredColorScheme(.dark)                // v2 is dark-only (was .light)
            // light: TODO — a later warm-cream (#f6f1e6) theme is a value swap here + a
            // colorScheme branch in Colors.swift; structure the tokens now, don't build it.
    }
}
```

- **`.preferredColorScheme(.dark)`** (was `.light`). This also makes **Liquid Glass adapt to dark automatically** (doc 04 §5.2) — glass reads correctly with no `colorScheme` branching.
- Keep `EosTheme` as the reserved empty marker. The doc-02 light-lock note is replaced by the light: TODO above. Structure tokens so the future warm-cream light theme is a `Colors.swift` value swap, not a call-site edit — but **do not build light in v1**.

### 1.5 Align `EosRunState.from` to the Mac vocabulary (`Colors.swift`)

The tree row's status dot + label must match the Mac's `statusFromState` (`app/ui/src/lib/format.js`). Extend the resolver so boot reads as running and the ending/killing/suspended states map correctly:

```swift
struct EosRunState {
    let dot: Color, soft: Color, label: String
    static func from(_ state: String) -> EosRunState {
        switch state {
        case "WORKING", "SPAWNING":         return .init(dot: .State.runningDot, soft: .State.runningSoft, label: "running")
        case "IDLE", "SUSPENDED", "DRAFT":  return .init(dot: .State.idleDot,    soft: .State.idleSoft,    label: "idle")
        case "ENDING":                      return .init(dot: .State.idleDot,    soft: .State.idleSoft,    label: "ending")
        case "DONE":                        return .init(dot: .State.idleDot,    soft: .State.idleSoft,    label: "done")
        case "KILLING":                     return .init(dot: .State.queuedDot,  soft: .State.queuedSoft,  label: "killing")
        case "FAILED", "ERROR":             return .init(dot: .State.failedDot,  soft: .State.failedSoft,  label: "failed")
        case "WAITING", "INPUT":            return .init(dot: .State.waitingDot, soft: .State.waitingSoft, label: "waiting")
        default:                            return .init(dot: .State.infoDot,    soft: .State.infoSoft,    label: state.lowercased())
        }
    }
}
```

(`.State.runningDot` shorthand assumes `EosColor.State` is imported into scope; write it as `EosColor.State.runningDot` in the real file.) Labels are **lowercase** to match the Mac's `ag-status` chip.

### 1.6 What re-themes AUTOMATICALLY vs. needs MANUAL change

**Automatic (token swap only — no view edits):**
- **All doc-03 transcript renderers** (`Views/Messages/**`): assistant prose, thinking, tool items/groups, agent blocks, reports, terminal, loop/git/system lines, all ~40 tool detail cards. They read `EosColor.*`/`EosFont.*`. New value ⇒ dark theme, PJS prose, blue accents. The doc-03 token mapping table (`--fg`→`ink`, `--accent`→`coral`, `--ok`→`runningDot`, …) now resolves to dark values — which is what the Mac renders, so this is *closer* to the source than the paper version was.
- **All primitives** (`StateDot`, `SectionText`, `WorkerRowNew`, `Avatar`, `ModelPill`, etc.) — pure token consumers.
- **Sheets** (`SpawnSheet`, `AskUserSheet`, `PendingListView`, `SettingsView`, `DevicesView`, `ModelPickerSheet`) — token-driven backgrounds/text.

**Manual (real edits — enumerated so nothing is missed):**
1. **`Colors.swift`, `Typography.swift`, `Theme.swift`, `Sunburst.swift`** — the swaps + `DawnStar` (§1.1–1.5).
2. **`AssistantMessageView` / Markdown prose** — verify no `design: .serif` remains hard-coded anywhere the token isn't used; the code-fence card (`CodeBlockView`) is **already a dark card** (github-dark-dimmed via Highlightr per doc 03 §5.4) → it now sits correctly on the dark surface (previously a dark inset on paper). **Confirm the inline-code fill uses `surface2` `#252525`** (was `bgSunken`), not a paper value — update if the view referenced `bgSunken` for inline code (doc 03 mapped `--surface-2` → `bgSunken`; on dark, `surface2` is the right token).
3. **`coralWash` semantics** — on paper it was a warm tint (user bubble, selected chip). On dark, `#212B35` is a *desaturated slate*, correct for the user bubble and selected-row wash. **Verify the user-message bubble (`UserMessageView`) and the tree-row selection still read** with it; if a brighter selection is wanted, use `coral.opacity(0.14)` instead (a live blue tint). Pick one (§3.3).
4. **Glass chrome** — the top bar, composer, FAB, drawer, device list, pending banner, sheets get `.glassEffect` / `.glassProminent` (§2, §3). This is net-new material, not a token swap.
5. **`DawnStar` call sites** — Home hero + `TranscriptFoot` (§1.2).
6. **Wordmark** — `"Eos"`→`"eos"`, tracking (§1.3/§3.1).
7. **`SectionCaption`** — the Mac tree uses lowercase-ish muted captions; the current `SectionCaption` uppercases. For the tree section headers ("orchestrators"), **either keep uppercase or switch to sentence-case** to match the Mac — cosmetic, decide in §3.3.

---

## 2. Glass component inventory (per doc 04)

**Master rule (doc 04 §3.1, non-negotiable):** glass = the **navigation layer** (floating chrome). **Content = opaque dark.** No glass-on-glass; every adjacent glass cluster wrapped in a `GlassEffectContainer`; **tint on at most one element per screen** (the primary action / dawn-mark), never decoration.

### 2.1 The split — what is glass, what is opaque

| Surface | Layer | Material |
|---|---|---|
| Top chrome bar (hamburger + trailing) | nav | **Glass** — the two circular buttons share one `GlassEffectContainer`; float over the scrolling content. |
| Composer (field + control row + send) | nav | **Glass** — one container holding the field pill + send; pinned via `safeAreaInset(.bottom)`. |
| "+" new-session FAB / composer plus | nav | **Glass** (`.glassProminent` for the tinted primary; plain `.glass` for the composer's inline `+`). |
| Drawer panel (the sidebar surface) | nav | **Glass** — ONE `.glassEffect(in: .rect(cornerRadius:))` on the panel; **rows inside are content** (not glass). |
| In-place device switcher list (popover over the drawer) | nav | **Glass** — a single glass panel; device rows inside are content. |
| Pending banner (above composer) | nav | **Glass** — one glass capsule/card; its Deny/Allow buttons are content-on-glass (one may be `.glassProminent`). |
| Sheets (Spawn, AskUser, ModelPicker, AddDevice, Pending detail) | nav | **Glass (automatic)** — declare `.presentationDetents`, **remove any `.presentationBackground`** (doc 04 §2.4). |
| **Transcript blocks** (assistant prose, tool cards, terminal, agent cards, all doc-03 views) | content | **Opaque** `surface`/`surface2`. Never glass. |
| **Tree rows** (orchestrator/worker hierarchy) | content | **Opaque** — dark rows on `bg`; selection = `coralWash`/tint fill, not glass. |
| **Fleet/home hero, empty states, cards** | content | **Opaque** `surface`. |
| Background | base | `EosColor.bg` `.ignoresSafeArea()` — the thing glass samples. |

### 2.2 New / changed primitives

| Primitive | File | Change |
|---|---|---|
| `CircularIconButton` | `Components/CircularIconButton.swift` | Add a `glass: Bool = false` mode: when true, drop the `surface` fill + hairline and apply `.glassEffect(in: .circle)` (plain) — for the top-chrome buttons. `filled` → route to `.buttonStyle(.glassProminent)` + `.tint(EosColor.coral)` for the send/primary (brand-tinted glass). Keep the opaque variant for message-action icons (content layer). |
| `Composer` | `Components/Composer.swift` | Wrap the field + send in a `GlassEffectContainer(spacing: 8)`; the outer card becomes glass (`.glassEffect(in: .rect(cornerRadius: EosRadius.composer))`) instead of `surface` + shadow. The `+` and `ModelPill` sit on the composer's glass (content-on-glass, not their own glass). Send → `.glassProminent` tinted. Add `@FocusState` binding + keyboard Done (bug 3). Remove the `.shadow` (glass has its own depth). |
| `PillButton` | `Components/PillButton.swift` | `.primary` → `.buttonStyle(.glassProminent)` + `.tint(EosColor.coral)` (brand glass) where it's a floating primary; keep the opaque capsule for in-sheet/in-card buttons (content). `.ghost` stays outlined content. |
| `GlassTopBar` (new, replaces `TopChrome` internals) | `App/TopChrome.swift` | The HStack's two `CircularIconButton`s wrapped in `GlassEffectContainer`; hosted via `safeAreaInset(.top)` (unchanged host mechanism). Bar itself has **no background** — the buttons are the glass, floating (doc 04 §2.3 "no `Color`/`Material` behind bar items"). |
| `DrawerGlass` (new) | `App/SidebarContainer.swift` | The drawer panel gets one `.glassEffect(in: .rect(cornerRadius: 24, style: .continuous))`; the content behind (dimmed) shows through. Rows stay opaque content. |
| `PendingBanner` (new) | `Views/PendingBanner.swift` (new file) | Inline glass banner above the composer (§3.4). |
| `DeviceSwitcherList` (new) | `App/SidebarView.swift` or new `App/DeviceSwitcher.swift` | In-place glass popover from the device chip (§3.5). |
| `AgentTreeRow` (new) | `Views/FleetTree.swift` (new file) | Opaque hierarchy row (§3.3). |
| `SettingsFooter` (new) | `App/SidebarView.swift` footer | Content row → opens `SettingsView` (§3.6). |

**Accessibility (wire from the start, doc 04 §5.3):** glass auto-frosts under Reduce Transparency; for text-critical custom glass (composer, pending banner) also gate `.glassEffect(reduceTransparency ? .identity : .regular)` where legibility matters. Reduce Motion already gates the drawer spring (current `SidebarContainer`); extend to the FAB/composer morphs.

---

## 3. Screen-by-screen redesign

### 3.1 Shell — safe-area-correct glass chrome + drawer (bugs 1 & 2)

**Current state:** `SidebarContainer` clips content at the safe-area inset (content doesn't claim the notch); the drawer uses a fixed 24pt clip + a `scaleEffect` peek. `TopChrome` is transparent circular buttons via `safeAreaInset(.top)`. This is close — the fixes are targeted.

**Bug 1 — top clip / content must claim the safe area.**
- The **background** claims the full screen: in each screen's root, `EosColor.bg.ignoresSafeArea()` as the base layer (already the pattern in `HomeView`/`WorkerDetailView`; ensure it's a `ZStack` base, not a `.background` on the safe-area-inset content).
- The **chrome floats** via `safeAreaInset` (already done). The dark bg then bleeds under the Dynamic Island; the glass top bar floats on top and **samples** the content scrolling beneath it (doc 04 §3.1). Remove any `.clipShape`/inset that stops content reaching the top edge — the `SidebarContainer`'s `content` should not clip at the top; only the **drawer-open corner-round** clips (bug 2).
- Net rule (doc 04 §4.1): `.ignoresSafeArea` on the **bg layer only**; `safeAreaInset` for the chrome. The current `content.background(EosColor.bg)` inside `SidebarContainer` should be `content` over a `ZStack { EosColor.bg.ignoresSafeArea(); content }` so the dark reaches the notch even before per-screen backgrounds paint.

**Bug 2 — drawer corners.**
- **Progress-driven radius** (not a fixed 24 toggled on open): `cornerRadius = 24 * progress` so the corner rounds *as* the drawer opens (the current code toggles `isOpen ? 24 : 0` which snaps). Use `.clipShape(RoundedRectangle(cornerRadius: 24 * progress, style: .continuous))`.
- **Full-screen clip matched to the device corner radius:** the revealed main content should round to ~the device's screen corner radius (≈ `UIScreen`'s `_displayCornerRadius` ≈ 44–55 on modern iPhones, or a safe `39`), not a smaller inner radius, so the peek edge sits concentric with the physical screen. Hardcode a `deviceCornerRadius: CGFloat = 39` constant (or read the private displayCornerRadius defensively) and interpolate `deviceCornerRadius * progress`.
- **Reconsider the `scaleEffect`:** it currently scales the main content `1 - 0.03*progress` anchored trailing. This is the doc-02 "peek" but can cause a 1px seam at the rounded corner against the glass drawer. **Recommendation:** keep a *smaller* scale (`1 - 0.02*progress`) OR drop the scale and instead **rebuild the drawer per doc 04 §3.4** — the drawer panel as a single `.glassEffect(in: .rect(cornerRadius:))` sliding in from the left, the main content dimmed by the scrim (no scale). The glass-drawer-without-scale reads cleaner on dark and removes the seam. Flag as the §5.7 decision; default to the glass drawer, scale dropped.
- The drawer **panel** is glass (§2.1); its rows (`SidebarRow`, recents, device chip, settings footer) are opaque content sitting on the glass — do **not** give them their own glass (glass-on-glass).

**Glass top bar.** `TopChrome` wraps its two buttons in `GlassEffectContainer(spacing: 8)`; each `CircularIconButton(glass: true)`. No bar background. On Home the trailing is **removed** (pending is now a banner, not a top-right button — §3.4); the top-right can be **empty** (clean, per the reference cockpit) or hold a subtle connection affordance — **default: empty on Home**, Interrupt (`stop.circle`, glass) on WorkerDetail (unchanged role, glassified).

**Wordmark + nav.** `SidebarView`: `Text("eos").font(EosFont.display... )` — actually use a dedicated wordmark style: `Text("eos").font(EosFont.titleSerif).tracking(-0.5)` (PJS SemiBold, tight). **Remove the Pending / Devices / Settings `SidebarRow`s** (§3.6 moves them). The drawer becomes: wordmark → **device chip** (opens in-place switcher, §3.5) → **Fleet** row (the only nav row, or drop it entirely since Fleet is the home surface) → "recents"/tree → **settings footer** (§3.6). Recents can be **replaced by the hierarchy tree** living in the drawer *or* stay a flat recents list with the tree on the Home surface — see §3.3.

### 3.2 Home / new-session flow

**Requirement:** a "+" (not "Spawn worker") clears selection → blank compose (breadcrumb "new orchestrator" + empty transcript + composer). The **first message** calls `spawnOrchestrator` with the composer's model/effort/permission/cwd. No spawn form.

**Structure.** The Fleet section root is either the **tree** (busy fleet) or the **new-session blank state** (nothing selected). Introduce a `@State selection: Selection` where `Selection = .none | .newOrchestrator | .worker(String)`:

- **`.newOrchestrator`** (the "+" target and the empty-fleet default): a blank compose surface —
  - top chrome: hamburger + (empty trailing); a small **breadcrumb** under the bar: the `DawnStar(size: 20)` + `Text("new orchestrator").font(.caption).foregroundStyle(inkTertiary)`.
  - body: empty (a centered faint `DawnStar(56)` + optional "Describe a task to start an orchestrator" hint on `bg`).
  - `safeAreaInset(.bottom)`: the glass `Composer`, placeholder "Start an orchestrator…", model/effort from `@AppStorage` defaults, `onModelTap` → `ModelPickerSheet`.
  - **submit** = `spawnOrchestrator`: build `{ prompt, model, effort, permissionMode, cwd }` and `POST /orchestrators`. On success, switch `selection = .worker(newId)` so the transcript opens live.
- **The "+"** (a glass FAB, or the composer's `+`, or a top-bar affordance) sets `selection = .newOrchestrator` and clears the field. Recommendation: a **glass "+" FAB** bottom-trailing on the tree surface (doc 04 §3.3), *and* the drawer's primary action becomes "+ new orchestrator" (replacing the old "Spawn worker" pill). Both route to `.newOrchestrator`.

**`cwd` problem (must solve).** `POST /orchestrators` requires `cwd` (min 1). On mobile there's no directory picker for the Mac's filesystem. Options:
- **(a, recommended)** Default `cwd` to the device's configured project root — add a per-device `defaultCwd` (settings, §3.6), prefilled from the Mac (the daemon can report a default working dir, or the first orchestrator's cwd). Until wired, **(b)** a required one-line "Working directory" field in the compose breadcrumb (prefilled from the last-used cwd in `@AppStorage`), so the first send has a real path. **Flag as §5.7 decision** — the composer can't spawn an orchestrator without a cwd, so *something* must supply it. Default to (b) with an `@AppStorage("lastCwd")` prefill for v1, upgrade to (a).

**`spawnOrchestrator` on iOS (new code, §5 step 4).** Add to `DeviceConnection`:
```swift
func spawnOrchestrator(body: JSONValue) async { await control("POST", "/orchestrators", body) }
```
and forward from `AppModel`: `func spawnOrchestrator(body: JSONValue) async { await active?.spawnOrchestrator(body: body) }`. The response carries the new id (mirror the Mac's `SpawnOrchestratorResponse`); select it.

**Greeting.** Drop the "Hey there, {name}" paper-era hero from the *tree* surface (it's a Claude-ism); keep a subtle `DawnStar` + "eos" only on the **empty/new-session** state. The tree surface leads with the hierarchy, not a greeting — this is the cockpit shift.

### 3.3 Hierarchy tree (replaces the flat list) — mirror the Mac `buildAgentTree`

**Requirement:** roots = orchestrators; children = workers via `parent_id`; recursive depth; sort by `started_at`; per-node collapse (chevron, persisted); compact row = chevron + status dot (`statusFromState`) + name (+ `(definition)` suffix) + optional loop/attention pip + status label; **no tokens/cost in the row**; tap → transcript.

**Data (new file `EosRemoteKit/Data/AgentTree.swift`, port of `app/ui/src/lib/tree.js`):**
```swift
public struct AgentNode: Identifiable, Sendable {
    public let worker: Worker
    public let depth: Int
    public var children: [AgentNode]
    public var id: String { worker.id }
}
// Roots = no parent_id (or a parent_id pointing at a missing row). Children sorted by started_at ASC.
public func buildAgentTree(_ workers: [Worker]) -> [AgentNode] { … }
public func flattenVisible(_ tree: [AgentNode], collapsed: Set<String>) -> [AgentNode] { … }
```
- `started_at` is on the raw row (`worker.raw["started_at"]?.doubleValue`) — add a `Worker.startedAt` accessor (`raw["started_at"] ?? raw["startedAt"]`). Roots and children both sort ascending by it (Mac semantics: oldest first).
- **Collapse state persisted** in `@AppStorage` per device (a `Set<String>` of collapsed ids, encoded as a JSON string keyed by `activeDeviceId` — or a lightweight `@Published Set` in a small `TreeState: ObservableObject` persisted to `UserDefaults`). Mirror the Mac's `collapsedNodes`.

**Row (`AgentTreeRow` in `Views/FleetTree.swift`) — opaque content, port of `AgentsTree.jsx` `TreeNode`:**
```
Button(tap → openWorker(node.id)) {
  HStack(spacing: 6) {
    // depth indent: leading padding = depth * 16 (or an indent guide line)
    if hasChildren { chevron(rotates 90° when expanded, toggles collapse, .stopPropagation) }
      else { spacer width 12 }
    StateDot(state: node.worker.state)                      // §1.5 status dot
    Text(node.worker.name).font(.label)                     // + (definition) suffix in inkFaint
      .foregroundStyle(node.worker.isOrchestrator ? .ink : .inkSecondary)   // orchestrators emphasized
    if let loop = node.worker.loop { loopPip(loop) }        // "loop"/"checking" pill, coral/violet
    if needsAttention { attentionPip() } else { Text(EosRunState.from(state).label).font(.captionSmall).foregroundStyle(.inkTertiary) }
    Spacer()
  }
  .padding(.vertical, EosSpacing.xs)
  .padding(.leading, CGFloat(node.depth) * 16)
  .background(isSelected ? EosColor.coralWash : .clear, in: RoundedRectangle(cornerRadius: EosRadius.chip))
}
```
- **No model/effort/tokens/cost** in the row (explicit requirement — the paper `WorkerRowNew` showed all of these; the tree row does NOT). Those live in the transcript / a future detail header only.
- **`(definition)` suffix:** the worker-definition name the worker was spawned from (`worker.raw["worker_definition"]` / the Mac's `ag-def`), rendered `inkFaint`, weight regular, after the name. Port the Mac's `AgentName` (name + optional definition suffix) as a small helper.
- **Loop pip:** `worker.loop` present → a `"loop"` pill (`coral` text on `coralWash`), flips to `"checking"` when a live goal-check is active for that worker (`AppModel.activeGoalCheck(for:)`). Mirrors `ag-loop-badge`.
- **Attention pip:** the Mac shows a dot when a worker "finished with new output" (idle + unseen). iOS has no per-agent seen-tracking yet — **render the status label** (`running`/`idle`/…) as the default; the attention pip is a **follow-up** (needs a seen-ledger). Flag minor.
- **Selection** highlights the row (`coralWash` or `coral.opacity(0.14)`); tap opens the transcript (`openWorker`), which on iOS pushes `WorkerDetailView` (current nav) — keep the push, or move to selection-drives-detail (§5.7). Default: keep the existing `path.append(id)` push.

**Placement.** The tree is the **Fleet section root** (the Home surface), replacing `HomeView`'s flat `List` sections. A `ScrollView { LazyVStack { ForEach(flattenVisible(tree, collapsed)) { AgentTreeRow($0) } } }` on `bg`, with the glass "+" FAB (§3.2) and the pending banner (§3.4) as `safeAreaInset`s. Section captions ("orchestrators") are **optional** — the tree's roots ARE the orchestrators, so a caption is redundant; drop it (the Mac tree has no section headers). Keep swipe-to-Kill on rows (`swipeActions` → confirm → `AppModel.kill`), preserved from `HomeView`.

**Empty tree** (no workers): the **new-session blank state** (§3.2), not a "No workers yet" line — the "+" / composer is right there. If loading (first fetch not resolved), a muted "Loading…" (mirror the Mac's `loaded` gate).

### 3.4 Worker transcript (re-themed) + pending banner

**Transcript.** `WorkerDetailView` + the doc-03 renderer **stay** — re-themed dark automatically (§1.6). Verify:
- Background `EosColor.bg.ignoresSafeArea()` as the ZStack base (bug 1).
- The `Composer` is glass now (§2.2), pinned `safeAreaInset(.bottom)` (already), with the keyboard fixes (bug 3).
- `TranscriptFoot` uses `DawnStar(size: 13)` (§1.2) + the reworded disclaimer.
- Code cards (`CodeBlockView`, github-dark-dimmed) now sit correctly on dark (were a dark inset on paper).

**Bug 3 — keyboard.** In `WorkerDetailView` (and the new-session composer):
- `@FocusState private var composerFocused: Bool`, bound into `Composer` (add a `focused` binding param to the primitive).
- `.scrollDismissesKeyboard(.interactively)` on the transcript `ScrollView` (the Messages feel).
- **Release focus on send:** `composerFocused = false` in `send()`.
- **Keyboard Done:** `.toolbar { ToolbarItemGroup(placement: .keyboard) { Spacer(); Button("Done") { composerFocused = false } } }`.
This is doc 04 §4.4's recommended trio (gesture + action + explicit). No keyboard-height observers.

**Pending banner (bug: remove the "Not connected"/nav-button pattern; requirement: inline banner above the composer).** New `Views/PendingBanner.swift`, port of the Mac `PermissionBanner` (`app/ui/src/views/code/center/PermissionBanner.jsx`), shown **above the composer for the selected agent** as an additional `safeAreaInset(.bottom)` (stacked above the composer inset, or a VStack in the same inset).
- **Source:** the selected worker's pending items — filter `AppModel.pending` by `workerId == selectedWorkerId`. Show the first; if >1, a "N pending" count. (The Mac shows the global front-of-queue; on a per-worker transcript, filter to that worker.)
- **Layout (glass card):** `perm-dot` (waiting amber) + "Allow **{name}** to run **{tool}**?" + optional detail (`summary`/command) in mono + **actions**: `Deny` (danger, `.ghost`) · `Always allow` · `Allow once` (`.glassProminent` tinted primary).
- **Wiring:** `Allow once` → `AppModel.approve(pendingId:allow:true)`; `Deny` → `approve(pendingId:allow:false)`. **`Always allow`** has **no iOS backend** (needs `addPolicyRule`) — either **omit it in v1** (recommended, keep Deny + Allow once) or add a `POST /policy/rule` forward to `DeviceConnection`. Flag §5.7. Default: **Deny + Allow once only**, add "Always allow" as a follow-up.
- **On the tree surface** (no worker selected / new-session), the banner can show the **global** front-of-queue pending (any worker) so decisions aren't missed — or rely on the drawer. Recommendation: show the global front-of-queue banner on the tree surface too (decisions are time-sensitive). The old top-right "Pending" button and its badge dot are **removed** (requirement).

**Bug 4 — remove the "Not connected" banner overflowing the composer.** Delete `RootView.connectionBanner` (the bottom overlay). Surface connection via the **device-chip dot** in the drawer (already present: `CurrentDeviceChip` shows `connectionState`'s `StateDot`) — and, when **no device is paired**, the composer is disabled with a "Tap to add a device" prompt (§3.5). No floating connection banner.

### 3.5 Device switcher — in-place list (not the Devices screen)

**Requirement:** tapping the sidebar device chip opens an **in-place list** (not the Devices screen) with a "+" at the bottom to add via QR. No devices → composer **disabled** + a centered "Tap to add a device".

- **`CurrentDeviceChip`** (already in `SidebarView`) currently calls `select(.devices)` (navigates to the Devices screen). **Change** its action to toggle an **in-place glass popover** anchored below the chip, within the drawer.
- **`DeviceSwitcherList` (new, glass panel):** a compact list of `model.devices`, each row = `StateDot(connectionState)` + label + a `checkmark` (coral) when active; tap → `AppModel.switchDevice(id)` + close the drawer (switch is instant per 5a). **Bottom "+ Add device"** row → presents the QR `AddDeviceSheet`. This is the drawer-local, in-place equivalent of `DevicesView`'s list — **reuse `DeviceRow`'s content** (minus the standalone-screen chrome), rendered on the switcher's single glass surface (rows opaque-on-glass, not their own glass).
- **`DevicesView` is demoted:** no longer a sidebar nav row (§3.6 removes it). Keep the file for **remove/manage** depth (reachable from Settings, or from a long-press on a switcher row → remove). The switcher handles the common case (switch + add); full management (remove with confirmation, relay host) lives in Settings or a "Manage devices" push. Default: switcher = switch + add; **remove** via a swipe/long-press in the switcher calling `AppModel.removeDevice` (confirm), so the Devices screen becomes optional.
- **No devices:** `AppModel.needsPairing == true` (or `devices.isEmpty`). The **composer is disabled** (both new-session and any transcript) and shows a centered tappable "Tap to add a device" that presents the QR sheet. The drawer's device chip becomes an "Add a device" affordance. This replaces the old `needsPairing` → auto-present-pairing behavior with an explicit, in-place tap (keep the auto-present on very first launch if desired, but the disabled-composer prompt is the always-available path).

### 3.6 Settings footer (move settings to the bottom-left, remove nav rows)

**Requirement:** move Settings to a bottom-left footer where the profile/avatar is (like the Mac `SettingsFooter`). Remove Pending/Devices/Settings as sidebar nav rows.

- **`SidebarView` footer:** replace the `HStack { Avatar; Spacer; PillButton("Spawn worker") }` with:
  - a **settings footer row** (bottom-left, port of Mac `SettingsFooter.jsx`): a gear icon + "Settings", tapped → present `SettingsView` (sheet or push). Full-width, quiet (`inkSecondary`), on the drawer's glass.
  - the primary action becomes **"+ new orchestrator"** (§3.2) — either as the footer's trailing pill or as the FAB on the tree surface (default: FAB on the surface; footer holds settings only, matching the Mac where the footer is settings-only).
  - the **avatar** is optional — the Mac footer is just Settings. Keep a small `Avatar`/account glyph only if the account label is meaningful; otherwise drop it (the cockpit doesn't need a profile chip). Default: **settings-only footer**, no avatar.
- **Remove nav rows:** delete the `Pending`, `Devices`, `Settings` `SidebarRow`s from `SidebarView` (§3.1 already removes them from the nav group). The drawer's nav is now: wordmark → device chip (→ switcher) → the tree/recents → settings footer. **Fleet** as an explicit nav row is redundant (it's the home surface) — drop it too; the drawer opens onto the tree by default.
- **`RootView.rootContent`** collapses: the `switch sidebar.section` over `.fleet/.pending/.devices/.settings` **goes away** — there is only the Fleet/tree surface as the root; Pending is a banner, Devices is the switcher popover, Settings is a sheet from the footer. `SidebarSection` and `SidebarState.section` are **removed** (the drawer no longer switches root sections — it only opens/closes and drives selection). This is a real simplification of the shell.

### 3.7 Empty / edge states (all addressed)

| State | v2 |
|---|---|
| No devices paired | Composer disabled + centered "Tap to add a device" (→ QR). Device chip = "Add a device" (§3.5). |
| No workers (device connected) | The **new-session blank state**: faint `DawnStar` + "Start an orchestrator…" composer (§3.2). Not "No workers yet". |
| Fleet loading (first fetch pending) | Muted "Loading…" (mirror Mac `loaded` gate). |
| No pending for selected worker | No banner (banner is absent, composer sits at the bottom). |
| Disconnected (device paired, dropped) | Device-chip dot goes gray/red (`connectionState`); **no** floating banner (bug 4). Transcript stays; sends queue per existing `queueWhenBusy`. |
| Empty transcript (fresh orchestrator) | The `ProcessingLine` spark (doc 03) + composer; the top-of-transcript task card is absent for a root orchestrator. |

---

## 4. Bug-fix summary (baked into the shell, cross-referenced)

| # | Bug | Fix | Where |
|---|---|---|---|
| 1 | Top clip — content doesn't claim the safe area; `SidebarContainer` clips at the inset | `bg` `.ignoresSafeArea()` as ZStack base; chrome via `safeAreaInset`; remove the top clip on `content`; dark bleeds under the Dynamic Island, glass floats over it | §3.1; doc 04 §4.1 |
| 2 | Drawer corners — snapped radius, seam from `scaleEffect` | Progress-driven radius (`deviceCornerRadius * progress`), full-screen clip matched to the device corner; drop/shrink the scale, or rebuild the drawer as a single glass panel (doc 04 §3.4) | §3.1; doc 04 §3.4 |
| 3 | Keyboard | `@FocusState` in `Composer` + `.scrollDismissesKeyboard(.interactively)` + release focus on send + keyboard-`Done` toolbar | §3.4; doc 04 §4.4 |
| 4 | "Not connected" banner overflows the composer | Delete `RootView.connectionBanner`; show connection via the device-chip dot; no-device → disabled composer + "Tap to add a device" | §3.4/§3.5 |

---

## 5. Ordered build plan (for the specialists)

Each phase leaves the app **buildable and runnable**. Dependencies noted. Phases 1–2 are the bulk of the visual shift; 3–6 are the structural features.

**Phase 1 — Foundation (tokens + mark + fonts).** *No dependencies. Unblocks everything.*
1. Bundle **Plus Jakarta Sans** `.ttf`s → `Resources/Fonts/`, register in `Info.plist` `UIAppFonts`.
2. `Colors.swift` — dark palette + cornflower `coral` + new tokens (`surface2/3`, `inkFaint`, `hairlineStrong`, `onAccent`) + `EosColor.State` dark values + the name-kept comment (§1.1). Extend `EosRunState.from` (§1.5).
3. `Typography.swift` — rebind all roles to PJS via `Font.custom(relativeTo:)` (§1.3).
4. `Theme.swift` — `.preferredColorScheme(.dark)`, drop light-lock, `light: TODO` (§1.4).
5. `Sunburst.swift` — add `DawnStar` (gradient + halo); keep `Sunburst` for the spark (§1.2).
   **Verify:** a preview-swatch screen renders the dark palette + PJS + `DawnStar`; the whole app (already token-driven) re-themes on build — spot-check the transcript renderer reads dark + PJS prose + blue accents (§1.6 automatic set). Fix the few manual token references (§1.6.2: inline-code `surface2`, `coralWash` semantics, `DawnStar` call sites, wordmark string).

**Phase 2 — Shell + glass + bugs 1/2/4.** *Depends on Phase 1.*
6. `TopChrome` → glass bar (`GlassEffectContainer` + `CircularIconButton(glass:)`), no bg (§2.2/§3.1).
7. `CircularIconButton`/`PillButton`/`Composer` → glass modes; `Composer` gains the `GlassEffectContainer` + `.glassProminent` send + `@FocusState`/keyboard `Done` (§2.2/bug 3 — the composer piece; the transcript wiring lands in Phase 3).
8. `SidebarContainer` → progress-driven radius + device-corner clip; drop/shrink scale OR rebuild drawer as one glass panel (§3.1/bug 2). Drawer panel glass; rows stay content.
9. `RootView` — **delete `connectionBanner`** (bug 4); **collapse `rootContent`** (remove `SidebarSection`/section switching — §3.6); bg claims safe area (bug 1).
   **Verify on device (iOS 27):** content bleeds under the notch; glass top bar + composer float and sample correctly; drawer opens with clean concentric corners, no seam; no floating connection banner. Profile glass perf (doc 04 §6).

**Phase 3 — Hierarchy tree.** *Depends on Phase 1 (tokens); independent of Phase 2 but shares the surface.*
10. `EosRemoteKit/Data/AgentTree.swift` — `buildAgentTree`/`flattenVisible` (port `tree.js`) + `Worker.startedAt`/`workerDefinition` accessors + a `TreeState` collapse store (persisted per device).
11. `Views/FleetTree.swift` — `AgentTreeRow` (opaque, chevron + dot + name + `(def)` + loop pip + status label; NO cost/tokens) + the tree `ScrollView`/`LazyVStack`, swipe-to-Kill.
12. Replace `HomeView`'s flat `List` sections with the tree as the Fleet-section root; keep the surface's `safeAreaInset`s (composer/FAB/banner slots).
    **Verify:** orchestrators are roots, workers nest by `parent_id`, sorted by `started_at`; collapse persists; tap opens the transcript; no cost in rows. Unit-test `buildAgentTree` against a fixture (mirror `messageParser`-style tests).

**Phase 4 — New-session flow.** *Depends on Phase 2 (glass composer) + Phase 3 (surface).*
13. `DeviceConnection.spawnOrchestrator(body:)` (POST `/orchestrators`) + `AppModel.spawnOrchestrator` forward (§3.2).
14. `Selection` state (`.none/.newOrchestrator/.worker`) on the Fleet surface; the "+" FAB / drawer primary → `.newOrchestrator`; blank compose (breadcrumb "new orchestrator" + `DawnStar` + composer); **first send** → `spawnOrchestrator` → select the new id.
15. `cwd` supply — `@AppStorage("lastCwd")` prefilled field in the compose breadcrumb (v1), or per-device `defaultCwd` (§3.2, §5.7 decision).
    **Verify:** "+" clears to a blank new-orchestrator compose; first message spawns an orchestrator with the chosen model/effort/permission/cwd and opens its live transcript; no spawn form appears.

**Phase 5 — Pending banner + device switcher + settings footer.** *Depends on Phase 2 (glass) + Phase 3/4 (surface).*
16. `Views/PendingBanner.swift` — glass banner above the composer (per-worker filter on the transcript; global front-of-queue on the tree); Deny + Allow once wired to `approve(pendingId:allow:)`; "Always allow" omitted (or `addPolicyRule` forward — §5.7). Stack it as a `safeAreaInset(.bottom)` above the composer.
17. `App/DeviceSwitcher.swift` — in-place glass popover from `CurrentDeviceChip`; switch (instant) + add (QR) + optional remove; no-device → disabled composer + "Tap to add a device" (§3.5).
18. `SidebarView` — settings footer (port `SettingsFooter.jsx`) → present `SettingsView`; remove the Pending/Devices/Settings/Fleet nav rows; device chip → switcher (not the Devices screen) (§3.6).
    **Verify:** a real pending request shows the inline banner for the right worker; Deny/Allow once resolve it; the device chip opens the in-place switcher (switch is instant); settings opens from the footer; no nav rows remain.

**Phase 6 — Polish + a11y + cleanup.** *Depends on all above.*
19. Glass accessibility: Reduce Transparency `.identity` fallbacks on text-critical glass (composer, banner); Reduce Motion on the FAB/composer/drawer morphs; VoiceOver labels on every glass button; tint on ≤1 element per screen (audit).
20. Remove orphans: `SidebarSection`/`SidebarState.section` if fully unused; the old `connectionBanner`; the paper-era greeting; any `WorkerRowNew` usages the tree replaces (keep the type only if still referenced). **Only remove what THIS redesign orphaned** (per the surgical-changes rule).
21. Dynamic Type + contrast audit on dark (ink `#ebebeb` on `bg` `#1a1a1a` ≈ 13:1; `inkTertiary` `#8a8a8a` ≈ 4.5:1 — fine for ≥ small; cornflower `#6ea4e8` on `bg` ≈ 6:1 — usable for text/glyphs, unlike the old coral-on-paper). Profile glass on the iOS 27 device.
    **Verify:** lint + the iOS test suites (`EosRemoteKitTests`) pass; the tree/parse unit tests pass; on-device a11y sweep clean.

**Do NOT run `eos build`/`eos restart` during development** (project rule — it crashes running workers). Verify with the iOS build + `EosRemoteKitTests` + on-device.

---

## 6. Open decisions (flagged, each with a recommendation)

1. **Token names kept vs. renamed** (`coral`→blue value; `bodySerif`/`titleSerif`→PJS). **Recommend: keep the names** (value-only swap; ~40 call sites re-theme with zero churn); add clarifying comments. Rename only as a *separate* mechanical commit if desired. (§1.1/§1.3)
2. **Drawer rebuild vs. patch.** Progress-driven radius + drop scale (patch) vs. rebuild as a single glass panel per doc 04 §3.4. **Recommend: rebuild as one glass panel, scale dropped** — cleaner concentric corners on dark, removes the seam. (§3.1)
3. **New-session `cwd`.** **Recommend: `@AppStorage("lastCwd")` prefilled field in the compose breadcrumb for v1**, upgrade to a per-device `defaultCwd` reported by the daemon. The orchestrator can't spawn without a cwd — this must ship. (§3.2)
4. **"Always allow" in the pending banner.** **Recommend: omit in v1** (Deny + Allow once only) — iOS has no `addPolicyRule` forward. Add a `POST /policy/rule` `DeviceConnection` method as a fast follow if wanted. (§3.4)
5. **Pending banner scope on the tree surface.** **Recommend: show the global front-of-queue** pending on the tree (decisions are time-sensitive), per-worker filter on a transcript. (§3.4)
6. **Selection wash.** `coralWash` `#212B35` (desaturated slate) vs. `coral.opacity(0.14)` (live blue tint) for selected rows/user bubble. **Recommend: `coralWash` for the user bubble (quiet), `coral.opacity(0.14)` for the tree selection** (a touch more present) — or unify on `coralWash`. (§1.6/§3.3)
7. **Devices screen retention.** **Recommend: keep `DevicesView` reachable from Settings for full management** (remove/relay-host), with the switcher handling switch+add+quick-remove — so the standalone screen is optional, not deleted. (§3.5)
8. **Attention pip.** The Mac's "finished with new output" dot needs a per-agent seen-ledger iOS lacks. **Recommend: ship the status label now; add the attention pip as a follow-up** with a seen-ledger. (§3.3)
9. **Avatar in the footer.** **Recommend: settings-only footer, no avatar** (matches the Mac; the cockpit doesn't need a profile chip). Keep the avatar only if the account label is meaningful. (§3.6)

---

*End of spec. §1 is the token swap (the bulk of the visual shift, ~2 files); §2 is the glass split; §3 is the screen-by-screen restructure + the 4 bug fixes; §5 is the ordered build plan with dependencies; §6 is the decisions to confirm. Everything builds ON the already-implemented doc-02 primitives + doc-03 renderer — this is a re-theme + restructure, not a rewrite.*
