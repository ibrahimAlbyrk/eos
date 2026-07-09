# 02 — iOS Design System (Claude-mobile aesthetic, Eos domain)

**Status:** Design spec only. No code in this document ships as-is until reviewed; it is written to be copy-implementable.
**Scope:** Visual redesign of the native SwiftUI iOS app at `ios/` to match the Claude mobile app's "warm paper + serif" aesthetic, re-mapped onto Eos's fleet-control domain.
**Targets:** iOS 26+, Swift 6, SwiftUI, XcodeGen (`ios/project.yml`). This is a **restyle/refactor** of the existing app — not a rewrite. The current navigation model, `AppModel`, transport, and data layer stay; only the presentation layer changes.

---

## 0. What exists today (grounding)

The redesign layers onto this structure. File references are the surfaces we restyle.

| Surface | File | Current shape | Redesign action |
|---|---|---|---|
| App entry | `App/EosRemoteApp.swift` | `WindowGroup { RootView() }` | Inject `.eosTheme()` root modifier; force light scheme (see §7). |
| Root shell | `App/RootView.swift` | `NavigationStack(path:)` + `.toolbar` (leading pair `Menu`, trailing `+`), `.sheet` × 2, bottom `.overlay` connection banner, `.onOpenURL` deep links | Wrap in a **drawer container** (`SidebarContainer`); replace system toolbar with custom circular top chrome; keep deep-link routing + banner. |
| Fleet list | `Views/FleetView.swift` | `List(.insetGrouped)`; `WorkerRow`, `StateChip` (Circle, green/secondary/red/orange/blue), `PendingBanner` | Re-skin rows onto `paper` surface; `StateChip` → token state dots; add Home/landing above the list. |
| Worker detail | `Views/WorkerDetailView.swift` | `ScrollView` + `LazyVStack` of `BlockView`, `.defaultScrollAnchor(.bottom)`, bottom composer (`.thinMaterial`, `TextField` + `arrow.up.circle.fill`) | Serif transcript body; replace composer with `Composer` primitive; per-message action row. |
| Transcript block | `Views/BlockView.swift` | Bubbles (`RoundedRectangle` r12) + `Label` rows; ~16 `Block.Kind`s | Serif prose for assistant; token colors; keep kind→variant switch. |
| Pending | `Views/PendingListView.swift` | `List`, headline + summary + Deny/Approve buttons | Re-skin as decision cards; Approve = solid black `PillButton`. |
| Spawn | `Views/SpawnSheet.swift` | `Form` (prompt, dir, model picker Opus 4.8/Sonnet 5/Haiku 4.5, effort low/med/high, advanced disclosure) | Keep `Form` semantics; restyle header + confirm as `PillButton`; the Home composer is the *fast path* into this. |
| Ask user | `Views/AskUserSheet.swift` | `Form`, question + options (multi-select) + free text | Re-skin; serif question, token selection checks. |
| Pairing | `Pairing/PairingView.swift`, `Pairing/QRScannerView.swift` | Scanner + status text | Light-only re-skin (out of scope for tokens beyond palette). |
| State bridge | `App/AppModel.swift` | `@MainActor ObservableObject`; `workers`, `pending`, `transcript`, `orchestrators`/`plainWorkers` split | **Unchanged.** Consumed as-is. |
| Domain | `EosRemoteKit/Models/Domain.swift` | `Worker` (state/model/effort/tokens/costUSD), `Pending`, `Block.Kind` | **Unchanged.** |

**State vocabulary** (authoritative, from `FleetView.StateChip`): `RUNNING`/`WORKING` → running, `IDLE`/`DONE` → idle, `FAILED`/`ERROR` → failed, `WAITING`/`INPUT` → waiting, anything else → a neutral "info" state. The token palette (§1) names exactly these.

**Design principle for the whole spec:** the Claude look is *warmth + generous whitespace + serif prose + minimal chrome*. Eos is an operations console, so we add one thing Claude does not need — **legible run-state at a glance** (colored state dots, live token/cost). We keep everything else austere.

---

## 1. Design tokens

### 1.1 File structure

Create a new group `EosRemote/DesignSystem/`. XcodeGen picks it up automatically (the `EosRemote` target globs `path: EosRemote`; no `project.yml` change needed, no manual `pbxproj` edits). Add these files:

```
EosRemote/DesignSystem/
  Theme.swift        // EosTheme env value + .eosTheme() modifier + light-scheme lock
  Colors.swift       // EosColor palette (semantic names) + Color(hex:) init
  Typography.swift   // EosFont roles (serif display/heading/prose + SF label/caption/mono)
  Spacing.swift      // EosSpacing scale, EosRadius scale, EosLine (hairline widths)
  Sunburst.swift     // the coral asterisk logo (custom Shape) — see §2.8
```

Everything is a plain Swift `enum` namespace of `static let`s — no runtime cost, no singletons, trivially previewable. Colors are defined in code (not the asset catalog) so the palette is diffable, greppable, and reviewable in one file; the asset catalog keeps only `AppIcon`.

> Rationale: code-defined tokens keep the whole system in five reviewable files, match the repo's "single source of truth" habit, and let previews render without the catalog. If we later add dark mode (§7) we can promote colors into a `Color Set` or switch on `colorScheme` inside `Colors.swift` without touching call sites.

### 1.2 Color palette — light "paper" (`Colors.swift`)

Hex values are the target aesthetic. All are opaque unless noted. The accent is the coral/terracotta the reference centers on.

| Token | Hex | Role |
|---|---|---|
| `bg` | `#F5F4EF` | App background — warm bone/paper. The base everywhere. |
| `bgSunken` | `#EFEEE7` | Recessed wells (behind grouped lists, scrim base tint). |
| `surface` | `#FBFAF7` | Cards, composer, sheets — a hair lighter than `bg` so they lift without a border. |
| `surfaceHi` | `#FFFFFF` | Pressed/active surface, popovers that must pop. |
| `ink` | `#1F1E1C` | Primary text — near-black, warm (not pure `#000`). |
| `inkSecondary` | `#6B6862` | Secondary text, captions, inactive icons. |
| `inkTertiary` | `#9C988F` | Placeholders, disabled, timestamps. |
| `hairline` | `#E4E2DA` | 0.5–1pt separators, circular-button outlines, composer border. |
| `coral` | `#D97757` | **Accent.** Sunburst logo, active nav highlight, links, focus ring. |
| `coralPressed` | `#C25E3E` | Accent pressed. |
| `coralWash` | `#F3E4DC` (≈ coral @ 12%) | Accent-tinted fills (selected chip, user-message wash). |
| `onDark` | `#F7F6F2` | Text/glyph on the solid-black pill + voice button. |
| `black` | `#111110` | Solid pill / primary-action button fill (warm black, not `#000`). |

**State colors** (map 1:1 to the state vocabulary in §0). Each has a `dot` (the saturated fill for the status dot) and a `soft` (a low-alpha wash for chip backgrounds / row tint):

| State | `…Dot` | `…Soft` (≈ dot @ 14%) | Applies to |
|---|---|---|---|
| `running` | `#3E9E6E` (green) | `#E1F0E8` | `RUNNING`, `WORKING` |
| `idle` | `#9C988F` (warm gray) | `#ECEAE3` | `IDLE`, `DONE` |
| `failed` | `#C7513A` (brick red — harmonizes with coral) | `#F4E0DA` | `FAILED`, `ERROR` |
| `waiting` | `#C08A2D` (amber) | `#F3E9D5` | `WAITING`, `INPUT` |
| `info` | `#4A76B8` (muted blue) | `#E1E8F2` | default / unknown |

> Note on red: the state-failed red is pulled toward terracotta (`#C7513A`) instead of a pure iOS red so it doesn't fight the coral accent. Destructive *actions* (Kill, Deny) may still use a slightly hotter red — see `Colors.danger` below.

Two more action tokens:

| Token | Hex | Role |
|---|---|---|
| `danger` | `#C0392B` | Destructive action text/fill (Kill, Deny, Disconnect). |
| `focusRing` | `coral` @ 40% | Keyboard/VoiceOver focus outline. |

**Concrete Swift:**

```swift
// Colors.swift
import SwiftUI

enum EosColor {
    // surfaces
    static let bg         = Color(hex: 0xF5F4EF)
    static let bgSunken   = Color(hex: 0xEFEEE7)
    static let surface    = Color(hex: 0xFBFAF7)
    static let surfaceHi  = Color(hex: 0xFFFFFF)
    // ink
    static let ink          = Color(hex: 0x1F1E1C)
    static let inkSecondary = Color(hex: 0x6B6862)
    static let inkTertiary  = Color(hex: 0x9C988F)
    static let hairline     = Color(hex: 0xE4E2DA)
    // accent
    static let coral        = Color(hex: 0xD97757)
    static let coralPressed = Color(hex: 0xC25E3E)
    static let coralWash    = Color(hex: 0xF3E4DC)
    // pill / on-dark
    static let black  = Color(hex: 0x111110)
    static let onDark = Color(hex: 0xF7F6F2)
    // actions
    static let danger    = Color(hex: 0xC0392B)
    static var focusRing: Color { coral.opacity(0.4) }

    // run-state (dot = saturated, soft = wash)
    enum State {
        static let runningDot = Color(hex: 0x3E9E6E); static let runningSoft = Color(hex: 0xE1F0E8)
        static let idleDot    = Color(hex: 0x9C988F); static let idleSoft    = Color(hex: 0xECEAE3)
        static let failedDot  = Color(hex: 0xC7513A); static let failedSoft  = Color(hex: 0xF4E0DA)
        static let waitingDot = Color(hex: 0xC08A2D); static let waitingSoft = Color(hex: 0xF3E9D5)
        static let infoDot    = Color(hex: 0x4A76B8); static let infoSoft    = Color(hex: 0xE1E8F2)
    }
}

// Color+Hex.swift (or inline in Colors.swift)
extension Color {
    init(hex: UInt32, alpha: Double = 1) {
        self.init(.sRGB,
                  red:   Double((hex >> 16) & 0xFF) / 255,
                  green: Double((hex >> 8)  & 0xFF) / 255,
                  blue:  Double(hex & 0xFF) / 255,
                  opacity: alpha)
    }
}
```

**State → color helper** (one place resolves the raw `Worker.state` string). Put next to the palette so the switch and the vocabulary live together:

```swift
// Colors.swift (continued)
struct EosRunState {
    let dot: Color, soft: Color, label: String
    static func from(_ state: String) -> EosRunState {
        switch state {
        case "RUNNING", "WORKING": return .init(dot: EosColor.State.runningDot, soft: EosColor.State.runningSoft, label: "Running")
        case "IDLE", "DONE":       return .init(dot: EosColor.State.idleDot,    soft: EosColor.State.idleSoft,    label: "Idle")
        case "FAILED", "ERROR":    return .init(dot: EosColor.State.failedDot,  soft: EosColor.State.failedSoft,  label: "Failed")
        case "WAITING", "INPUT":   return .init(dot: EosColor.State.waitingDot, soft: EosColor.State.waitingSoft, label: "Waiting")
        default:                    return .init(dot: EosColor.State.infoDot,    soft: EosColor.State.infoSoft,    label: state.capitalized)
        }
    }
}
```

### 1.3 Typography (`Typography.swift`)

The reference uses a **serif for display + prose** and a **sans for UI labels**. On iOS the built-in serif is **New York**, reached via `Font.system(..., design: .serif)` — no bundled font, no license, and it ships Dynamic Type + optical sizes for free. UI labels/captions use **SF Pro** (`design: .default`); code/mono uses **SF Mono** (`design: .monospaced`).

Every role is defined as **relative to a Dynamic Type text style** (`.system(_:design:)` with a text-style argument), so the whole app scales with the user's setting (§7 accessibility). Fixed point sizes are given only as the reference (`.large` category) rendering.

| Role | Definition | ~pt @ Large | Where |
|---|---|---|---|
| `display` | `.system(.largeTitle, design: .serif).weight(.regular)` then `.tracking(-0.4)` | 34 | Home greeting "Hey there, Ibrahim". |
| `titleSerif` | `.system(.title2, design: .serif).weight(.semibold)` | 22 | Sidebar "Eos" wordmark, sheet titles, section display headings. |
| `heading` | `.system(.title3, design: .serif).weight(.semibold)` | 20 | Card / detail headings. |
| `bodySerif` | `.system(.body, design: .serif)` | 17 | **Assistant transcript prose** (the comfortable serif body). Line spacing +4 (§3.4). |
| `bodySerifEmph` | `bodySerif.weight(.semibold)` | 17 | Bold spans inside prose. |
| `label` | `.system(.subheadline, design: .default).weight(.medium)` | 15 | Sidebar nav labels, buttons, worker names. |
| `labelStrong` | `.system(.headline, design: .default)` | 17 | Emphasized UI (pill text, primary action). |
| `body` | `.system(.body, design: .default)` | 17 | Non-prose UI text, form fields. |
| `caption` | `.system(.footnote, design: .default)` | 13 | "Recents" caption, timestamps, the AI-disclaimer line, model·effort meta. |
| `captionSmall` | `.system(.caption2, design: .default)` | 11 | Dense meta (token counts). |
| `mono` | `.system(.footnote, design: .monospaced)` | 13 | Cost `$0.42`, ids, token digits, diff/code snippets. |

```swift
// Typography.swift
import SwiftUI

enum EosFont {
    static let display        = Font.system(.largeTitle, design: .serif).weight(.regular)
    static let titleSerif     = Font.system(.title2,     design: .serif).weight(.semibold)
    static let heading        = Font.system(.title3,     design: .serif).weight(.semibold)
    static let bodySerif      = Font.system(.body,       design: .serif)
    static let bodySerifEmph  = Font.system(.body,       design: .serif).weight(.semibold)
    static let label          = Font.system(.subheadline, design: .default).weight(.medium)
    static let labelStrong    = Font.system(.headline,   design: .default)
    static let body           = Font.system(.body,       design: .default)
    static let caption        = Font.system(.footnote,   design: .default)
    static let captionSmall   = Font.system(.caption2,   design: .default)
    static let mono           = Font.system(.footnote,   design: .monospaced)
}
```

> `display` gets negative tracking (`-0.4`) applied at the call site via `.tracking(-0.4)` — kept out of the `Font` value because `tracking` is a view modifier, not a font property. Everything else uses default tracking.

### 1.4 Spacing, radii, hairlines (`Spacing.swift`)

An 8-pt-ish scale with a couple of in-between stops the reference needs (the composer is roomy, chrome is tight).

```swift
// Spacing.swift
import CoreGraphics

enum EosSpacing {
    static let xxs: CGFloat = 4
    static let xs:  CGFloat = 8
    static let sm:  CGFloat = 12
    static let md:  CGFloat = 16   // default screen inset
    static let lg:  CGFloat = 24   // section gaps
    static let xl:  CGFloat = 32
    static let xxl: CGFloat = 48   // vertical breathing around the Home hero
    static let screenInset: CGFloat = 20   // left/right page margin (Claude runs generous)
}

enum EosRadius {
    static let chip:     CGFloat = 8
    static let card:     CGFloat = 16   // decision cards, message wells
    static let composer: CGFloat = 28   // the big rounded composer card
    static let pill:     CGFloat = 999  // fully rounded (model pill, Spawn pill, circular buttons via frame)
}

enum EosLine {                     // hairline widths
    static let hairline: CGFloat = 1
    static let button:   CGFloat = 1.5   // circular icon-button outline
}
```

**Circular button diameter** and **composer min-height** are component constants, defined with the components (§2), not global tokens.

### 1.5 Theme wiring (`Theme.swift`)

A single `EosTheme` value carried in the environment lets previews and future theming swap palettes without touching call sites. For v1 it just holds the light palette accessors; the real win is the one root modifier that (a) sets the app background, (b) sets the SwiftUI accent to coral, and (c) locks light mode (§7).

```swift
// Theme.swift
import SwiftUI

struct EosTheme { /* v1: empty marker; palette is accessed via EosColor directly.
                     Reserved so a future dark theme is a value swap, not a call-site edit. */ }

private struct EosThemeKey: EnvironmentKey { static let defaultValue = EosTheme() }
extension EnvironmentValues { var eosTheme: EosTheme {
    get { self[EosThemeKey.self] } set { self[EosThemeKey.self] = newValue } } }

extension View {
    /// Root styling: paper background, coral accent, light-locked (see §7).
    func eosTheme() -> some View {
        self
            .tint(EosColor.coral)                 // system controls, links, focus
            .background(EosColor.bg.ignoresSafeArea())
            .environment(\.eosTheme, EosTheme())
            .preferredColorScheme(.light)         // v1 ships light-only (§7)
    }
}
```

Apply once in `EosRemoteApp`:

```swift
WindowGroup { RootView().eosTheme() }
```

---

## 2. Component primitives

New group `EosRemote/DesignSystem/Components/`. Each is a small, self-contained `View`. Sketches show hierarchy + the load-bearing modifiers; props are the initializer surface.

### 2.1 `CircularIconButton`

Thin-outlined circle with a centered SF Symbol — the top-chrome hamburger, ghost, interrupt, and per-message action icons.

**Props:** `systemName: String`, `diameter: CGFloat = 40`, `filled: Bool = false` (false = outlined on paper, true = solid black like the voice button), `action: () -> Void`, plus an `accessibilityLabel: String`.

```
Button(action:)
 └ ZStack
    ├ Circle().fill(filled ? EosColor.black : EosColor.surface)
    │   .overlay(Circle().strokeBorder(EosColor.hairline, lineWidth: EosLine.button))  // outline only when !filled
    └ Image(systemName:).font(.system(size: diameter * 0.42, weight: .regular))
        .foregroundStyle(filled ? EosColor.onDark : EosColor.ink)
 .frame(width: diameter, height: diameter)
 .contentShape(Circle())
 .accessibilityLabel(accessibilityLabel)
```

Variants used: outlined 40pt (top chrome, message actions at ~32pt), filled 44–52pt (Home voice/primary — see §2.3).

### 2.2 `ModelPill`

Rounded pill showing "Opus 4.8 · High", tappable to open the model/effort picker.

**Props:** `model: String`, `effort: String?`, `action: () -> Void`.

```
Button(action:)
 └ HStack(spacing: EosSpacing.xxs)
    ├ Text(shortModel(model))            // "Opus 4.8"  (map claude-opus-4-8 → "Opus 4.8")
    │   .font(EosFont.label)
    ├ if let effort: Text(effort.capitalized).font(EosFont.caption).foregroundStyle(EosColor.inkSecondary)
    └ Image(systemName: "chevron.down").font(.caption2).foregroundStyle(EosColor.inkSecondary)
 .padding(.horizontal, EosSpacing.sm).padding(.vertical, EosSpacing.xs)
 .background(EosColor.surface, in: Capsule())
 .overlay(Capsule().strokeBorder(EosColor.hairline, lineWidth: EosLine.hairline))
 .foregroundStyle(EosColor.ink)
```

A `shortModel(_:)` helper maps the wire ids (`claude-opus-4-8`, `claude-sonnet-5`, `claude-haiku-4-5-20251001`) to display names — reuse the mapping already implied by `SpawnSheet`'s picker tags.

### 2.3 `Composer`

The signature card. Multiline growing text field with a `+` bottom-left, a `ModelPill`, a mic glyph, and a solid-black send/voice button bottom-right. One primitive serves **Home** ("Spawn a worker…") and **Worker detail** ("Reply to <name>"); the trailing button's role differs (see props).

**Props:**
- `text: Binding<String>`
- `placeholder: String`
- `model: String`, `effort: String?`, `onModelTap: () -> Void` — the pill
- `onPlus: () -> Void` — the `+` (Home: open full Spawn sheet; detail: attach/insert — see §3.5)
- `onMic: (() -> Void)?` — mic (nil hides it)
- `trailing: ComposerTrailing` — `.voice(action)` (Home idle: solid black waveform) **or** `.send(action, enabled: Bool)` (text present / reply context)

```
VStack(spacing: EosSpacing.xs)
 ├ TextField(placeholder, text:, axis: .vertical)          // grows vertically
 │   .font(EosFont.body)
 │   .lineLimit(1...6)                                       // grows to 6 lines then scrolls
 │   .tint(EosColor.coral)
 │   .frame(minHeight: 24, alignment: .topLeading)
 └ HStack(spacing: EosSpacing.sm)                            // control row
    ├ CircularIconButton("plus", diameter: 32, action: onPlus)
    ├ ModelPill(model:, effort:, action: onModelTap)
    ├ Spacer()
    ├ if let onMic: CircularIconButton("mic", diameter: 32, action: onMic)   // outlined
    └ switch trailing:
        .voice:  CircularIconButton("waveform", diameter: 40, filled: true, action:)
        .send:   CircularIconButton("arrow.up", diameter: 40, filled: true, action:)
                    .opacity(enabled ? 1 : 0.35).disabled(!enabled)
 .padding(EosSpacing.md)
 .background(EosColor.surface, in: RoundedRectangle(cornerRadius: EosRadius.composer, style: .continuous))
 .overlay(RoundedRectangle(cornerRadius: EosRadius.composer, style: .continuous)
            .strokeBorder(EosColor.hairline, lineWidth: EosLine.hairline))
 .shadow(color: .black.opacity(0.04), radius: 12, y: 4)     // soft lift, not a hard border
```

`enum ComposerTrailing { case voice(() -> Void); case send(() -> Void, enabled: Bool) }`.

Growth behavior: `axis: .vertical` + `lineLimit(1...6)` gives native multiline growth capped at 6 lines; beyond that the field scrolls internally. On focus, the parent screen should scroll the composer clear of the keyboard (standard `.safeAreaInset(edge: .bottom)` hosting handles this — see §3.1/§3.4).

> **Reuse note:** the existing `WorkerDetailView.composer` and `SpawnSheet`'s prompt field are both replaced by / fed from this one primitive. This is a deliberate consolidation (DRY) — one composer, two placements.

### 2.4 `PillButton`

Solid warm-black capsule — the "Spawn worker" / "New" primary, and the Approve action.

**Props:** `title: String`, `systemImage: String? = nil`, `style: PillStyle = .primary`, `action`.
`enum PillStyle { case primary /* black */; case coral; case ghost /* outlined */ }`.

```
Button(action:)
 └ HStack(spacing: EosSpacing.xs)
    ├ if let systemImage: Image(systemName:)
    └ Text(title).font(EosFont.labelStrong)
 .padding(.horizontal, EosSpacing.lg).padding(.vertical, EosSpacing.sm)
 .foregroundStyle(style == .ghost ? EosColor.ink : EosColor.onDark)
 .background(fill, in: Capsule())            // .primary→black, .coral→coral, .ghost→clear
 .overlay(style == .ghost ? Capsule().strokeBorder(EosColor.hairline, lineWidth: EosLine.button) : nil)
```

### 2.5 `SidebarRow`

One drawer nav row: thin line-icon + label, with a selected state (coral icon + subtle wash).

**Props:** `icon: String` (SF Symbol), `title: String`, `isSelected: Bool`, `badge: Int? = nil` (Pending count), `action`.

```
Button(action:)
 └ HStack(spacing: EosSpacing.sm)
    ├ Image(systemName: icon).font(.system(size: 20, weight: .regular))
    │   .foregroundStyle(isSelected ? EosColor.coral : EosColor.ink)
    │   .frame(width: 26)                                  // icon gutter aligns labels
    ├ Text(title).font(EosFont.label).foregroundStyle(EosColor.ink)
    ├ Spacer()
    └ if let badge, badge > 0: Text("\(badge)")            // small count chip
        .font(EosFont.captionSmall).padding(.horizontal, 6).padding(.vertical, 2)
        .background(EosColor.State.waitingSoft, in: Capsule())
        .foregroundStyle(EosColor.State.waitingDot)
 .padding(.vertical, EosSpacing.sm).padding(.horizontal, EosSpacing.xs)
 .background(isSelected ? EosColor.coralWash : .clear, in: RoundedRectangle(cornerRadius: EosRadius.chip))
 .contentShape(Rectangle())
```

Icon mapping for Eos sections (SF Symbols, line weight): **Fleet** `square.stack.3d.up` (or `rectangle.3.group`), **Pending** `exclamationmark.bubble` (badge-bearing), **Devices** `laptopcomputer`, **Settings** `gearshape`.

### 2.6 `SectionHeader` and `SectionCaption`

Two tiny text primitives for the "Recents" caption and list section titles.

```swift
// SectionCaption: muted all-caps-ish caption ("Recents", "ORCHESTRATORS")
Text(title.uppercased())
  .font(EosFont.captionSmall).tracking(0.6)
  .foregroundStyle(EosColor.inkTertiary)
  .padding(.horizontal, EosSpacing.xs).padding(.top, EosSpacing.md).padding(.bottom, EosSpacing.xxs)

// SectionHeader: serif display heading for on-page groups
Text(title).font(EosFont.heading).foregroundStyle(EosColor.ink)
```

### 2.7 `Avatar`

Circular monogram (the sidebar "IA").

**Props:** `initials: String`, `diameter: CGFloat = 36`, `background: Color = EosColor.coral`.

```
Circle().fill(background)
 .frame(width: diameter, height: diameter)
 .overlay(Text(initials).font(.system(size: diameter * 0.4, weight: .semibold)).foregroundStyle(EosColor.onDark))
 .accessibilityLabel("Account: \(initials)")
```

Initials source: derive from the paired device/account label if available (`UIDevice.current.name` is already read in `AppModel.startPairing`); fall back to `"IA"`.

### 2.8 `Sunburst` — the coral asterisk logo

**Recommendation: a custom `Shape`, not an SF Symbol.** The reference mark is a specific many-armed asterisk/sunburst with tapered spokes; `sparkle` (4 arms) and `asterisk` (6 straight strokes) don't match, and a custom shape scales crisply, tints with `coral`, and can subtly animate later (spawn pulse). It's ~20 lines.

**Props:** `spokes: Int = 8`, `innerRatio: CGFloat = 0.32`, drawn in the view's frame; color applied by the caller via `.foregroundStyle(EosColor.coral)`.

```
struct Sunburst: Shape {
    var spokes = 8; var innerRatio: CGFloat = 0.32
    func path(in rect: CGRect) -> Path {
        // Star polygon: 2*spokes vertices alternating outer radius / inner radius (innerRatio),
        // centered in rect. Round the outer tips slightly for the soft terracotta look.
        …
    }
}
// Usage: Sunburst().fill(EosColor.coral).frame(width: 56, height: 56)
```

Two placements: large (56pt) centered on Home; small (13pt, inline) before the AI-disclaimer caption in the transcript foot.

> If schedule is tight, a **stopgap** is `Image(systemName: "sparkle").foregroundStyle(EosColor.coral)` — acceptable for a first build, replace with `Sunburst` before ship. Flag which was used in the PR.

### 2.9 `StateDot` (evolves the existing `StateChip`)

Keep the name-compatible role of `FleetView.StateChip` but drive it from `EosRunState` (§1.2) and add an optional label pill for denser rows.

```
// dot only (list rows)
Circle().fill(EosRunState.from(state).dot).frame(width: 8, height: 8)
  .accessibilityLabel(EosRunState.from(state).label)

// labeled chip (detail header)
HStack(spacing: 6) { Circle().fill(rs.dot).frame(width:7,height:7); Text(rs.label).font(EosFont.captionSmall) }
  .padding(.horizontal, EosSpacing.xs).padding(.vertical, 3)
  .background(rs.soft, in: Capsule()).foregroundStyle(EosColor.ink)
```

---

## 3. Screen-by-screen structure

### 3.1 Drawer container (how the sidebar layers over `NavigationStack`)

The reference sidebar is a **left drawer that slides the current screen right**, revealing a rounded-corner "peek" of it behind a dim scrim. This is *not* a `NavigationSplitView` (that's a two-column iPad idiom and won't give the peek/scrim/drag feel). Implement a custom overlay container that wraps the existing `NavigationStack`.

New file `App/SidebarContainer.swift`:

```
SidebarContainer<Content>            // Content == the NavigationStack from RootView
 state: @State isOpen: Bool, dragX: CGFloat
 const drawerWidth = min(screen.width * 0.82, 340)

 ZStack(alignment: .leading) {
   // 1) SIDEBAR — sits underneath, pinned left, fixed width
   SidebarView(isOpen: $isOpen)          // §3.2
     .frame(width: drawerWidth)

   // 2) MAIN — the app; offset right when open, corner-rounded + scrim when revealing
   content
     .background(EosColor.bg)
     .clipShape(RoundedRectangle(cornerRadius: isOpen ? 24 : 0, style: .continuous))
     .overlay(scrim)                      // dim + tap-to-close, alpha ∝ progress
     .shadow(color: .black.opacity(0.12), radius: 16, x: -4)   // main casts shadow onto sidebar
     .offset(x: currentOffset)            // clamped(dragX) or drawerWidth when open
     .scaleEffect(1 - 0.03 * progress, anchor: .trailing)      // subtle "peek back" depth
 }
 .gesture(edgeDragGesture)               // see below
 .animation(.interactiveSpring(response: 0.35, dampingFraction: 0.86), value: isOpen)
```

- **Progress** = `currentOffset / drawerWidth` ∈ 0…1. `scrim` = `EosColor.ink.opacity(0.28 * progress)`, `.ignoresSafeArea()`, with an `.onTapGesture { isOpen = false }` and `.allowsHitTesting(isOpen)`.
- **Peek:** because MAIN offsets right and rounds its corner while SIDEBAR is drawn beneath, the previous screen's rounded left edge shows exactly as in the reference.
- **Drag-to-open:** a `DragGesture(minimumDistance: 10)`. To avoid stealing `NavigationStack` back-swipes and `List` scrolls, gate opening on an **edge start**: only begin translating when `value.startLocation.x < 24` (screen-left gutter) or when already open. On end, snap open if `translation.width > drawerWidth * 0.33 || predictedEnd > drawerWidth * 0.5`, else closed. While closed and not edge-started, pass through untouched.
- **Opening from the button:** the hamburger (`CircularIconButton`) sets `isOpen = true`; the spring animates it.

`RootView` change: wrap its `NavigationStack {…}` in `SidebarContainer { … }` and move the leading toolbar item's job to the hamburger in the top chrome (§3.4). Everything else in `RootView` (deep-link routing, `.sheet`s, connection banner `.overlay`, scene-phase resume) is preserved verbatim; the banner overlay stays anchored to the main content so it slides with it.

> Accessibility: when `isOpen`, apply `.accessibilityHidden(true)` to `content` and move VoiceOver focus into the sidebar; Escape / two-finger-scrub closes.

### 3.2 Sidebar content (`SidebarView`)

```
VStack(alignment: .leading, spacing: 0) {
  // wordmark
  Text("Eos").font(EosFont.titleSerif).foregroundStyle(EosColor.ink)
    .padding(.horizontal, EosSpacing.md).padding(.top, EosSpacing.xl).padding(.bottom, EosSpacing.lg)

  // nav
  SidebarRow("square.stack.3d.up",  "Fleet",    isSelected: section == .fleet)   { select(.fleet) }
  SidebarRow("exclamationmark.bubble","Pending", isSelected: section == .pending,
             badge: model.pending.count)                                          { select(.pending) }
  SidebarRow("laptopcomputer",      "Devices",  isSelected: section == .devices) { select(.devices) }
  SidebarRow("gearshape",           "Settings", isSelected: section == .settings){ select(.settings) }

  SectionCaption("Recents")
  ScrollView { LazyVStack(alignment: .leading, spacing: 2) {
     ForEach(recentWorkers) { w in                      // model.workers, most-recent first, capped ~12
        SidebarRecentRow(name: w.name, state: w.state)  // plain sans row; tap → open worker + close drawer
     }
  }}

  Spacer()

  // footer: avatar + New
  HStack {
    Avatar(initials: accountInitials)
    Spacer()
    PillButton("Spawn worker", systemImage: "plus", style: .primary) { openSpawn() }
  }
  .padding(EosSpacing.md)
}
.frame(maxWidth: .infinity, alignment: .leading)
.background(EosColor.bg)              // same paper; the shadow from MAIN separates them
```

**Nav mapping (final):**

| Reference | Eos section | Destination |
|---|---|---|
| Chats | **Fleet** | `FleetView` (orchestrators + workers) — the home surface. |
| Projects / Artifacts / Code | *dropped* | Eos has no project/artifact concept on mobile. |
| Dispatch | **Pending** | `PendingListView` (decisions), badge = `model.pending.count`. |
| — | **Devices** | new lightweight screen: paired Macs / connection status + Pair/Disconnect (surfaces what `AppModel.connected`/pairing already expose). |
| — | **Settings** | new: model defaults, appearance (reserved for dark-mode toggle, §7), about. |
| Recents | **Recents** | recent workers (`model.workers`), tap opens `WorkerDetailView`. |
| + New chat | **Spawn worker** | opens `SpawnSheet` (or the Home composer fast-path). |

`section` is a new `@State`/`AppStorage` enum in the container; selecting one sets the `NavigationPath` root content. For v1, **Fleet** and **Pending** already have screens; **Devices** and **Settings** are new thin views (can ship as stubs with the real re-skin and be filled in a follow-up — call this out in the implementation ticket).

### 3.3 Home / landing (empty/entry state)

A new `HomeView` becomes the root of the Fleet section when there's nothing selected — the greeting + composer surface. When the fleet is active it can either remain the top of the Fleet scroll (greeting → composer → live fleet list) or be the true empty state. **Recommendation:** make Home the *always-present top* of the Fleet screen (greeting + composer pinned above the worker list), so the composer is the primary "spawn" entry and the reference look is preserved even with a busy fleet. Empty fleet simply shows greeting + composer + a muted "No workers yet" line.

```
ZStack {
  EosColor.bg.ignoresSafeArea()
  VStack(spacing: 0) {
    // top chrome (§3.4) is hosted by the container, not here
    ScrollView {
      VStack(spacing: EosSpacing.lg) {
        Spacer(minLength: EosSpacing.xxl)
        Sunburst().fill(EosColor.coral).frame(width: 56, height: 56)   // §2.8
        Text("Hey there, \(firstName)")                                // "Hey there, Ibrahim"
          .font(EosFont.display).tracking(-0.4).foregroundStyle(EosColor.ink)
          .multilineTextAlignment(.center)
        // when fleet non-empty, the live list follows:
        FleetList()                                                     // re-skinned §3.6
      }
      .padding(.horizontal, EosSpacing.screenInset)
    }
    Composer(text: $draft, placeholder: "Spawn a worker…",
             model: defaultModel, effort: defaultEffort, onModelTap: openModelPicker,
             onPlus: openSpawnSheet, onMic: nil,
             trailing: draft.isEmpty ? .voice(startDictation)
                                     : .send(submitSpawn, enabled: true))
      .padding(.horizontal, EosSpacing.screenInset)
      .padding(.bottom, EosSpacing.xs)
  }
}
```

- **Composer submit on Home** = fast-path spawn: take `draft` as the prompt and call `AppModel.spawnWorker` with the default model/effort (the same body `SpawnSheet` builds). The `+` opens the full `SpawnSheet` for dir/tools/advanced. This makes "Spawn a worker…" the one-line quick path and the sheet the full form — mirroring Claude's "type here vs. attach" split.
- **Greeting name** = first token of the account/device label, fallback "there".
- `.safeAreaInset(edge: .bottom)` may host the composer instead of the `VStack` tail if we want it to float above the keyboard cleanly — either is fine; inset is the more robust choice for keyboard avoidance.

### 3.4 Top chrome (custom circular buttons)

Replace the system `.toolbar` in `RootView` with a custom overlay row so the buttons are the exact outlined circles from the reference. Host it as a top `.safeAreaInset(edge: .top)` on the main content (inside `SidebarContainer`'s `content`), so it stays put while the transcript/list scrolls and slides with the drawer.

```
HStack {
  CircularIconButton("line.3.horizontal", diameter: 40) { sidebar.isOpen = true }   // hamburger → drawer
  Spacer()
  // context title (optional): serif, small, centered — omit on Home for the clean look
  Spacer()
  CircularIconButton(trailingIcon, diameter: 40) { trailingAction() }
}
.padding(.horizontal, EosSpacing.screenInset)
.padding(.vertical, EosSpacing.xs)
.background(.clear)      // paper shows through; no toolbar bar/hairline
```

**Trailing button — Eos adaptation of the "ghost/incognito" glyph.** Eos has no incognito concept. **Recommendation: repurpose it as "Pending decisions"** — icon `exclamationmark.bubble` (or `bell`), showing a small coral badge dot when `model.pending.count > 0`, tap navigates to Pending. This keeps the top-right circular affordance and gives it a real, always-relevant job (decisions are the most time-sensitive thing on mobile). *Alternative:* make it the pair/connection status entry (the current leading `Menu`'s job). **Do not** keep a literal ghost glyph. On Home specifically, trailing = Pending; on Worker detail, trailing = **Interrupt** (`stop.circle`), preserving today's `WorkerDetailView` toolbar action.

### 3.5 Worker detail (transcript + composer)

Restyle `WorkerDetailView` in place; keep its `AppModel.openWorker/closeWorker`, paging, and `.defaultScrollAnchor(.bottom)`.

```
ZStack { EosColor.bg.ignoresSafeArea()
 VStack(spacing: 0) {
   // top chrome hosted by container: hamburger + centered serif worker name + Interrupt (stop.circle)
   ScrollView {
     LazyVStack(alignment: .leading, spacing: EosSpacing.md) {
       if model.hasOlder { ProgressView().onAppear { Task { await model.loadOlder() } } }
       ForEach(model.transcript) { MessageView(block: $0) }             // §3.7 (was BlockView)
       TranscriptFoot()                                                  // sunburst + disclaimer
     }
     .padding(.horizontal, EosSpacing.screenInset)
   }
   .defaultScrollAnchor(.bottom)
   Composer(text: $draft, placeholder: "Reply to \(worker?.name ?? "worker")",
            model: worker?.model ?? "", effort: worker?.effort, onModelTap: {/* detail: read-only or re-model */},
            onPlus: { /* attach/insert — or hide by passing a no-op + omit */ },
            onMic: startDictation,
            trailing: draft.isEmpty ? .voice(startDictation)
                                    : .send({ send(draft) }, enabled: true))
     .padding(.horizontal, EosSpacing.screenInset).padding(.bottom, EosSpacing.xs)
 }
}
.task(id: workerId) { await model.openWorker(workerId) }
.onDisappear { model.closeWorker(workerId) }
```

`TranscriptFoot`:
```
HStack(spacing: EosSpacing.xxs) {
  Sunburst().fill(EosColor.coral).frame(width: 13, height: 13)
  Text("Eos runs autonomous agents and can make mistakes. Review actions before approving.")
    .font(EosFont.caption).foregroundStyle(EosColor.inkTertiary)
}.padding(.vertical, EosSpacing.md)
```
(The disclaimer is reworded for Eos's domain — the risk here is *actions taken*, not *answers*.)

### 3.6 Fleet list (re-skinned rows)

Drop `.insetGrouped` `List` chrome in favor of paper rows on the Home scroll (§3.3), or keep a `List` with `.listStyle(.plain)` + `.scrollContentBackground(.hidden)` + `EosColor.bg` background if swipe-to-Kill is worth keeping (it is). Recommendation: **keep `List(.plain)`** for the free swipe actions, but strip its background:

```
List {
  if !model.orchestrators.isEmpty {
    Section { ForEach(model.orchestrators){ WorkerRowNew($0) } } header: { SectionCaption("Orchestrators") }
  }
  Section { ForEach(model.plainWorkers){ WorkerRowNew($0) } } header: { SectionCaption("Workers") }
}
.listStyle(.plain)
.scrollContentBackground(.hidden)          // remove system list background
.background(EosColor.bg)
```

`WorkerRowNew` (evolves `WorkerRow`):
```
HStack(spacing: EosSpacing.sm) {
  StateDot(state: worker.state)                              // §2.9
  VStack(alignment: .leading, spacing: 2) {
    Text(worker.name).font(EosFont.label).foregroundStyle(EosColor.ink).lineLimit(1)
    HStack(spacing: EosSpacing.xxs) {                        // meta
      if let m = worker.model { Text(shortModel(m)).font(EosFont.caption) }
      if let e = worker.effort { Text("· \(e)").font(EosFont.caption) }
      if let t = worker.tokens { Text("· \(t) tok").font(EosFont.captionSmall) }
    }.foregroundStyle(EosColor.inkSecondary)
  }
  Spacer()
  if let c = worker.costUSD { Text(String(format:"$%.2f", c)).font(EosFont.mono).foregroundStyle(EosColor.inkSecondary) }
}
.padding(.vertical, EosSpacing.xs)
.listRowBackground(EosColor.bg)
.listRowSeparatorTint(EosColor.hairline)
```
Swipe-trailing Kill (confirm) preserved exactly from today.

### 3.7 Message rendering (`MessageView`, evolves `BlockView`)

Keep the `switch block.kind` structure and the ~16 kinds. Change *how* the two common kinds look; keep the icon-label rows for tool/report/directive/etc. but tint from tokens.

- **Assistant** (`.assistant`, `.jsonl`): **serif prose**, no bubble — full-width, `EosFont.bodySerif`, `.lineSpacing(4)`, `EosColor.ink`. Bold spans use `bodySerifEmph` (when markdown is parsed; until then plain). This is the single biggest visual change and the heart of the aesthetic. Below each assistant message, an **action row**:
  ```
  HStack(spacing: EosSpacing.lg) {
    ForEach: CircularIconButton(icon, diameter: 30, action:)   // outlined, muted
  }  // icons: doc.on.doc (copy), square.and.arrow.up (share), play.circle (TTS),
     //        hand.thumbsup / hand.thumbsdown, arrow.clockwise (retry)
  .foregroundStyle(EosColor.inkSecondary)
  ```
  For Eos, wire what's real now: **copy** (copy block text), **retry** (re-send / re-message), maybe **share**. TTS/thumbs can render disabled or be omitted until backed — flag in ticket. Keep the row visually even if some are stubs.
- **User** (`.user`): a right-aligned wash bubble, `EosColor.coralWash` fill, `RoundedRectangle(cornerRadius: EosRadius.card)`, `EosFont.body`, `EosColor.ink`. (Keeps the sender asymmetry without heavy chrome.)
- **thinking**: muted italic-ish label row (`brain` + "Thinking…") in `EosColor.inkSecondary` — live streaming overlay already handled by `AppModel`.
- **tool / toolGroup / report / directive / peerRequest / exit / deliveryFailed / default**: keep today's `label(icon, text, color)` rows but recolor: tool→`info`, report→`running` (green), directive→`coral`, peerRequest→`info`, exit/deliveryFailed→`failed`. Use the state palette, not raw `.blue/.green/.red`.

> The `BlockView` WKWebView escape-hatch note (costly markdown/diff cards) is unaffected — the native baseline just gets the paper/serif treatment.

### 3.8 Pending, Spawn, Ask — sheet re-skins

- **PendingListView:** each pending → a **card** (`RoundedRectangle` r16, `EosColor.surface`, hairline). Tool name in `EosFont.heading` (serif), summary in `EosFont.body` secondary, TTL as a small `waiting` chip. Actions: **Deny** = `PillButton(.ghost)` in `danger` ink; **Approve** = `PillButton(.primary)` (solid black). Background `EosColor.bg`, `.scrollContentBackground(.hidden)`.
- **SpawnSheet:** keep the `Form` (it's the right control set for dir/model/effort/tools), but: sheet title "Spawn worker" in `EosFont.titleSerif`; the confirm toolbar button styled as a compact `PillButton(.primary)`; model `Picker` values unchanged. Presented from the Home `+` and the sidebar Spawn pill. Apply `.presentationBackground(EosColor.bg)` and tint.
- **AskUserSheet:** question in `EosFont.bodySerif` (it reads like an assistant turn); options as selectable rows with a coral `checkmark` when selected; Send = `PillButton(.primary)`. Same `Form` skeleton.
- **PairingView:** minimal — paper background, serif "Pair device" title, status text in `EosFont.caption`. No new components required.

### 3.9 Model / effort picker

The `ModelPill` tap opens a small sheet or `confirmationDialog` (a `.presentationDetents([.height(280)])` sheet is nicer): a serif "Model" header, the three models as selectable rows (Opus 4.8 / Sonnet 5 / Haiku 4.5), and an effort segmented row (low/medium/high). It writes back the Home default model/effort (`@AppStorage`) or, in a spawn context, the sheet's selection. This replaces reaching into `SpawnSheet` just to change the model on the fast path.

---

## 4. Dark mode & accessibility

### 4.1 Dark mode — **defer, but build for it**

**Recommendation: ship light-only in v1.** The entire target aesthetic is a *warm paper* look; there is no reference for the dark variant, so a dark palette would be invented, not matched — high risk of an off-brand result under time pressure. Lock light mode now via `.preferredColorScheme(.light)` in `.eosTheme()` (§1.5).

**But** structure for a cheap follow-up: all colors already route through `EosColor`, so dark mode later = add a parallel dark palette and resolve per `@Environment(\.colorScheme)` inside `Colors.swift` (or promote to asset `Color Set`s), plus drop the `.preferredColorScheme` lock and add a Settings toggle (the reserved slot in §3.2). No call-site changes. Put a one-line `// dark: TODO` next to the lock so the intent is discoverable. Do **not** scatter `colorScheme` checks through views now.

### 4.2 Accessibility

- **Dynamic Type with serif:** every `EosFont` role derives from a text style (§1.3), so New York scales with the user's size. Verify the Home `display` and `bodySerif` transcript at `.accessibility3+` — allow wrapping (`multilineTextAlignment`, no `lineLimit(1)` on the greeting), and let the composer grow. Avoid fixed heights on text containers; the circular buttons and dots may stay fixed (they're glyphs/status, not text).
- **Contrast:** `ink` on `bg` ≈ 14:1 (pass AAA). `inkSecondary #6B6862` on `bg` ≈ 4.7:1 (passes AA for text ≥ small). `coral #D97757` on `bg` ≈ 3.0:1 — **use coral for large text/glyphs and fills, not for small body copy**; the sunburst, active-nav icon, and pill fills are fine, but never set small caption text in coral on paper. Solid-black pills: `onDark` on `black` ≈ 16:1. State dots convey status by color **and** are backed by an accessibility label + the text label in the detail chip (never color-only in the detail header).
- **VoiceOver labels:** every `CircularIconButton` requires an explicit `accessibilityLabel` (icons alone are meaningless): hamburger → "Menu", trailing → "Pending decisions", composer plus → "Spawn options", mic → "Dictate", voice → "Voice input", send → "Send", message actions → "Copy"/"Retry"/etc. `StateDot` → the state label. `Avatar` → "Account: IA". The sunburst is decorative → `.accessibilityHidden(true)`.
- **Drawer & focus:** when the sidebar opens, hide the main content from VoiceOver (`.accessibilityHidden(isOpen)`), move focus to the wordmark, and support escape/scrub-to-close (§3.1). The scrim's tap-to-close needs an `.accessibilityAction` too.
- **Hit targets:** all interactive circles ≥ 40pt (Home voice 44–52pt); the 30–32pt message-action and composer `+`/mic buttons rely on `.contentShape` + adequate spacing — bump to 36pt if testing shows mis-taps. Minimum comfortable target is 44pt per HIG; treat 30–32pt as the visual glyph inside a 44pt tappable frame where space allows.
- **Reduce Motion:** gate the drawer spring and the `scaleEffect` peek behind `@Environment(\.accessibilityReduceMotion)` — fall back to a cross-fade / instant offset.
- **Reduce Transparency:** the composer/scrim use solid fills already (no `.thinMaterial` in the new design — the old composer's `.thinMaterial` is replaced by opaque `surface`), so nothing to special-case; keep it that way.

---

## 5. Implementation order (suggested, for the follow-up ticket)

1. `DesignSystem/` tokens (`Colors`, `Typography`, `Spacing`, `Theme`) + `Color(hex:)` + `.eosTheme()` in `EosRemoteApp`. Verifiable in isolation via a preview swatch screen.
2. Component primitives (`CircularIconButton`, `PillButton`, `ModelPill`, `Composer`, `SidebarRow`, `Avatar`, `Sunburst`, `StateDot`, `SectionCaption`). Each with a `#Preview`.
3. `SidebarContainer` + `SidebarView` + top chrome; wrap `RootView`'s `NavigationStack`. Verify drawer drag/peek/scrim on device.
4. `HomeView` (greeting + composer + fleet top) and the Fleet re-skin (`WorkerRowNew`, `StateDot`).
5. `MessageView` (serif assistant prose + action row) replacing `BlockView` internals.
6. Sheet re-skins: Pending cards, Spawn header/confirm, Ask, model picker.
7. Accessibility pass (Dynamic Type, VoiceOver labels, Reduce Motion) + contrast audit.

Each step is independently reviewable and leaves the app runnable. No `AppModel`/transport/data change is required at any step — this is purely presentational, which is why it can land incrementally behind the existing behavior.

---

## 6. Open decisions to confirm before building

- **Ghost button →** repurposed as **Pending** (recommended) vs. connection/pair entry. (§3.4)
- **Home composer submit →** fast-path spawn with defaults (recommended) vs. always open the full sheet. (§3.3)
- **Fleet layout →** `List(.plain)` for free swipe-Kill (recommended) vs. hand-rolled paper rows (loses swipe). (§3.6)
- **Sunburst →** custom `Shape` (recommended) vs. `sparkle` stopgap. (§2.8)
- **Devices/Settings →** ship as stubs in v1 (recommended) vs. defer the two nav rows until built out. (§3.2)
- **Dark mode →** defer, light-locked (recommended). (§4.1)
- **Message TTS/thumbs →** render disabled vs. omit until backed. (§3.7)
