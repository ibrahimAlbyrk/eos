# 04 — Liquid Glass Reference (SwiftUI, iOS 26/27)

**Status:** Research reference — copy-implementable. No code in this document ships as-is; it is the authoritative spec the redesign specialists follow when rebuilding the Eos iOS app (`ios/EosRemote/`) top-to-bottom in authentic Liquid Glass.
**Targets:** deployment target **iOS 26+**, test device **iOS 27**. Swift 6, SwiftUI, XcodeGen (`ios/project.yml`), built with the Xcode 26 SDK. Everything here is native SwiftUI — **no third-party glass libraries, no hand-rolled `.ultraThinMaterial` fakes** on the iOS-26 path.
**Relationship to `02-ios-design-system.md`:** that doc defines the Eos *aesthetic* (warm-paper palette, serif prose, tokens). This doc defines the *material and structural system* (glass, navigation, safe-area, keyboard). Where they meet: the brand coral accent from §1 of doc 02 becomes the **tint** applied to glass here (see §7). Doc 02's "force light scheme" note is **revisited** in §7.3 — Liquid Glass is designed to adapt to both schemes, so locking light is a product choice, not a technical requirement.

> **One-sentence mental model.** Liquid Glass is a material for the **navigation layer** — the floating chrome that sits *above* your scrolling content (bars, sheets, sidebars, floating buttons, the composer). Content itself (lists, transcript, cards of text) stays on the **content layer** and is generally **not** glass. Get this split right and 80% of the "over-glassing" and safe-area bugs disappear.

---

## 0. What you get for free vs. must opt into

The single biggest lever: **recompile the app with the Xcode 26 SDK.** Standard components adopt Liquid Glass automatically with zero code changes. Only *custom* floating UI needs the explicit `.glassEffect(…)` APIs.

| Surface | Free on recompile (Xcode 26 SDK)? | You must do |
|---|---|---|
| `NavigationStack` / `NavigationSplitView` bars | ✅ Bars float as glass, adapt on scroll | Nothing; remove any custom bar backgrounds you added pre-26 |
| `.toolbar` items | ✅ Grouped into shared glass capsules | Opt into `ToolbarSpacer` for custom groupings (§2.3) |
| `TabView` | ✅ Floating glass tab bar | Opt into `.tabBarMinimizeBehavior`, `.tabViewBottomAccessory` (§2.5) |
| `.sheet` + `.presentationDetents` | ✅ Glass background, morphs between detents | **Remove** custom `.presentationBackground` (§2.4) |
| `.searchable` | ✅ Adopts platform-correct placement + glass | Opt into `.searchToolbarBehavior(.minimize)` or a search `Tab` (§2.6) |
| Bordered `Button`, `Toggle`, `Slider`, `Picker` | ✅ Capsule shape, liquid-glass on interaction | Nothing |
| Scroll-edge legibility under bars | ✅ Automatic blur/fade behind bar items | **Remove** darkening/backgrounds behind bar items; tune with `.scrollEdgeEffectStyle` only if needed (§2.7) |
| **Custom floating views** (composer, FAB, chips, cards you want glassy) | ❌ | Apply `.glassEffect(…)`, wrap in `GlassEffectContainer` (§1) |

**Corollary do-not:** if a standard component already gives you glass, do **not** re-implement it with `.glassEffect`. Custom glass is for surfaces SwiftUI doesn't provide (Eos's floating composer, the "+" FAB, worker state chips that should morph). Everything else: use the standard component and delete your old backgrounds.

Sources: [Build a SwiftUI app with the new design — WWDC25 (323)](https://developer.apple.com/videos/play/wwdc2025/323/) (accessed 2026-07-09); [Adopting Liquid Glass — Technology Overviews](https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass) (accessed 2026-07-09).

---

## 1. Core APIs

### 1.1 `glassEffect(_:in:)`

The primitive. Renders a Liquid Glass shape *behind* a view and applies the glass foreground effects (vibrant, adaptive text/symbol color) *over* it. Defaults to the **regular** variant inside a **Capsule**.

**Official signature** ([`glassEffect(_:in:)`](https://developer.apple.com/documentation/swiftui/view/glasseffect(_:in:)), accessed 2026-07-09):

```swift
nonisolated
func glassEffect(
    _ glass: Glass = .regular,
    in shape: some Shape = DefaultGlassEffectShape()   // Capsule
) -> some View
```

There is also an `isEnabled:` overload for conditional application (see §5.2).

```swift
// Simplest form — capsule glass behind the label, vibrant adaptive text.
Label("Desert", systemImage: "sun.max.fill")
    .padding()
    .glassEffect()

// Custom shape.
Label("Desert", systemImage: "sun.max.fill")
    .padding()
    .glassEffect(in: .rect(cornerRadius: 16))
```

Note the argument order: the shape goes in the `in:` parameter, and it accepts any `Shape` — `.capsule` (default), `.rect(cornerRadius:)`, `.circle`, or `.rect(corner: .containerConcentric)` for concentricity (§7.4).

### 1.2 `Glass` — the material variant value

`Glass` is a value type you configure with chained methods, then pass to `glassEffect`.

| Variant / method | Signature | Meaning |
|---|---|---|
| `.regular` | `static var regular: Glass` | **Default. Use for ~everything.** Adaptive; samples and adapts to content behind it, legible on light *and* dark, colorful *and* plain backgrounds. |
| `.clear` | `static var clear: Glass` | Permanently, aggressively transparent. **Needs a dimming layer** behind it and bold foreground content or text is unreadable. Reserve for media-rich, edge-to-edge contexts (photo viewers). **Never** for Eos's text-heavy chrome. |
| `.tint(_:)` | `func tint(_ color: Color?) -> Glass` | Adds a vibrant color wash. Use to convey **meaning** (primary action, brand), not decoration. `nil` clears the tint. |
| `.interactive(_:)` | `func interactive(_ isEnabled: Bool = true) -> Glass` | iOS: makes the glass **react to touch** — scale, bounce, shimmer, light radiating toward nearby glass in the same container. Apply to custom controls the user taps/drags. |

Signatures confirmed at [`Glass.tint(_:)`](https://developer.apple.com/documentation/swiftui/glass/tint(_:)) and [`Glass.interactive(_:)`](https://developer.apple.com/documentation/swiftui/glass/interactive(_:)) (accessed 2026-07-09).

```swift
// Chaining: regular glass, brand-tinted, interactive.
myControl
    .glassEffect(.regular.tint(EosColor.coral).interactive())
```

**`.regular` vs `.clear` decision:** two variants exist, and **they must never be mixed in the same context** — each has distinct optics. Regular is the versatile, adaptive default; Clear is permanently transparent and legible only with a dimming layer under it. **For Eos: use `.regular` everywhere.** Clear is out of scope unless we ship a full-bleed media viewer. Source: [createwithswift — Liquid Glass variants](https://www.createwithswift.com/liquid-glass-redefining-design-through-hierarchy-harmony-and-consistency/) (accessed 2026-07-09).

### 1.3 `GlassEffectContainer` — why, when, spacing

**Why (the hard rule):** *glass cannot sample other glass.* Each `.glassEffect` samples what's behind it to compute its look; if two glass views overlap or sit near each other without coordination, their sampling is inconsistent and they render as an incoherent blur pile. A `GlassEffectContainer` gives all its glass children a **shared sampling region** so they look coherent, render more efficiently (one combined shape set), and can **morph** into each other.

**When:**
- **Always** when you have **2+ glass elements near each other** (a row of glass buttons, a FAB + its expanded actions, the composer + a floating send).
- Whenever you want two glass shapes to **merge/morph** (union) as they animate.
- Even for "just two buttons" — skipping the container is listed explicitly as a do-not (inefficient, no morphing).

**Overview** ([`GlassEffectContainer`](https://developer.apple.com/documentation/swiftui/glasseffectcontainer), accessed 2026-07-09): each glass view contributes a shape to a set that SwiftUI renders together, improving performance and enabling interaction/morphing.

**`spacing:`** controls how *eagerly* nearby glass shapes blend/merge. A **larger** `spacing` makes effects blend and merge sooner as they move together.

```swift
GlassEffectContainer(spacing: 40.0) {
    HStack(spacing: 40.0) {
        Image(systemName: "scribble.variable")
            .frame(width: 80, height: 80).font(.system(size: 36))
            .glassEffect()
        Image(systemName: "eraser.fill")
            .frame(width: 80, height: 80).font(.system(size: 36))
            .glassEffect()
            .offset(x: -40, y: 0) // as they approach, the two shapes fluidly merge
    }
}
```

**Spacing gotcha (important):** if the container's `spacing` **exceeds** the spacing of an inner layout container (e.g. the `HStack` spacing), glass effects may blend **even at rest** — the shapes look permanently fused. Keep container `spacing` ≤ your layout spacing unless you *want* a resting merge. Source: [Applying Liquid Glass to custom views](https://developer.apple.com/documentation/SwiftUI/Applying-Liquid-Glass-to-custom-views) (accessed 2026-07-09).

### 1.4 Morphing / union — `glassEffectID` + `@Namespace`

To animate one glass shape **into** another (expand/collapse, show/hide), give each element a `glassEffectID` in a shared `@Namespace`, inside a `GlassEffectContainer`, and drive the change with `withAnimation`.

**Signature** ([`glassEffectID(_:in:)`](https://developer.apple.com/documentation/swiftui/view/glasseffectid(_:in:)), accessed 2026-07-09):

```swift
nonisolated
func glassEffectID(_ id: (some Hashable & Sendable)?, in namespace: Namespace.ID) -> some View
```

Recipe (Apple's Landmarks sample, condensed):

```swift
@State private var isExpanded = false
@Namespace private var namespace

GlassEffectContainer(spacing: 16) {
    VStack(spacing: 16) {
        if isExpanded {
            ForEach(items) { item in
                ItemLabel(item)
                    .glassEffect(.regular, in: .rect(cornerRadius: 12))
                    .glassEffectID(item.id, in: namespace)   // each morphs from/to the toggle
            }
        }
        Button { withAnimation { isExpanded.toggle() } } label: { ToggleLabel(isExpanded) }
            .buttonStyle(.glass)
            .glassEffectID("toggle", in: namespace)          // the anchor
    }
}
```

`withAnimation` (default spring, or `.bouncy`) is what makes the shapes flow. There is also a `GlassEffectTransition` type and `.glassEffectUnion(id:namespace:)` to *statically* fuse a group of shapes into one, but the `glassEffectID` morph above covers Eos's needs (FAB expansion, composer accessory reveal). Sources: [Landmarks — Building an app with Liquid Glass](https://developer.apple.com/documentation/SwiftUI/Landmarks-Building-an-app-with-Liquid-Glass), [`GlassEffectTransition`](https://developer.apple.com/documentation/swiftui/glasseffecttransition) (accessed 2026-07-09).

### 1.5 Glass button styles

Two built-in styles bring glass to buttons without touching `.glassEffect`:

```swift
Button("Learn More") { }.buttonStyle(.glass)            // standard translucent glass
Button("Get Started") { }.buttonStyle(.glassProminent)  // filled, prominent (uses tint as fill)
```

`.glassProminent` is the analogue of `.borderedProminent` and picks up the ambient `.tint(…)` as its fill — this is how the brand-colored primary action (Eos "Send", "Approve") should be built. Confirmed at [`PrimitiveButtonStyle.glassProminent`](https://developer.apple.com/documentation/swiftui/primitivebuttonstyle/glassprominent) (accessed 2026-07-09).

Bordered buttons are **capsule** by default now; opt other shapes via `.buttonBorderShape(.capsule / .circle / .roundedRectangle)`.

### 1.6 `backgroundExtensionEffect()`

Lets a view (typically a header image or full-bleed background) **extend beyond the safe area** — mirrored/blurred into the edges — instead of hard-clipping, so glass chrome floating over it has something rich to sample. This is the *correct* way to do full-bleed backgrounds under glass (see §4.2), not `.ignoresSafeArea` on the content itself.

**Signature** ([`backgroundExtensionEffect(isEnabled:)`](https://developer.apple.com/documentation/swiftui/view/backgroundextensioneffect(isenabled:)), accessed 2026-07-09):

```swift
@MainActor @preconcurrency
func backgroundExtensionEffect(isEnabled: Bool = true) -> some View
```

```swift
ScrollView {
    Image(landmark.backgroundImageName)
        .resizable().aspectRatio(contentMode: .fill)
        .backgroundExtensionEffect()   // bleeds under bars/status bar without clipping
}
```

---

## 2. Structural components in Liquid Glass

All of the below adopt glass **automatically** on the Xcode 26 SDK. The code you write is only to *customize* or *opt into* extra behavior.

### 2.1 NavigationStack / NavigationSplitView

- `NavigationStack` bars float as glass and adapt as content scrolls under them — no code.
- `NavigationSplitView` renders the **sidebar as a floating glass pane** over the detail content. Ideal for iPad; on iPhone it collapses to a stack.
- `.inspector(isPresented:)` adds a subtly-layered glass inspector tied to the current selection.

```swift
NavigationSplitView {
    SidebarContent()          // floating glass sidebar (free)
} detail: {
    DetailContent()
}
.inspector(isPresented: $showInspector) { InspectorContent() }
```

For Eos: the existing **custom drawer** (`SidebarContainer` from doc 02 §0) is a design choice. If we instead adopt `NavigationSplitView`, the glass sidebar is free — evaluate in the redesign. Either way, **do not** paint your own background behind a glass sidebar.

### 2.2 Zoom / matched transitions

Sheets and pushes can **morph out of the button that triggered them** using a matched namespace — the glassy "grow from the tapped control" motion:

```swift
@Namespace private var namespace

Button { showSheet = true } label: { Image(systemName: "plus") }
    .matchedTransitionSource(id: "spawn", in: namespace)

// …
.sheet(isPresented: $showSheet) {
    SpawnSheet()
        .navigationTransition(.zoom(sourceID: "spawn", in: namespace))
}
```

Use this for Eos's "+" → SpawnSheet and confirmation dialogs (which morph out of their button automatically).

### 2.3 Toolbars — `.toolbar`, `ToolbarSpacer`, sharing/merging glass groups

Adjacent toolbar items are **automatically merged into one shared glass capsule.** You control the grouping with **`ToolbarSpacer`**:

- `ToolbarSpacer(.fixed)` — a fixed gap that **splits** items into separate glass groups.
- `ToolbarSpacer(.flexible)` — expanding space (e.g. push items to opposite ends of a bottom bar).
- `.sharedBackgroundVisibility(.hidden)` on an item — pulls it into its **own** group with **no** shared background (e.g. a lone profile avatar).

```swift
.toolbar {
    ToolbarItem { ShareLink(item: url) }
    ToolbarSpacer(.fixed)                 // ← breaks the shared glass here
    ToolbarItem { FavoriteButton() }
    ToolbarItem { CollectionsButton() }   // these two share one glass group
    ToolbarSpacer(.fixed)
    ToolbarItem { InspectorToggle() }
}

// Bottom bar with a flexible gap + a search item pinned right:
.toolbar {
    ToolbarItem(placement: .bottomBar) { FilterPicker() }
    ToolbarSpacer(.flexible, placement: .bottomBar)
    DefaultToolbarItem(kind: .search, placement: .bottomBar)
    ToolbarSpacer(.fixed, placement: .bottomBar)
    ToolbarItem(placement: .bottomBar) { NewMessageButton() }
}

// Isolate one item into its own bare group:
.toolbar {
    ToolbarItem { ProfileButton() }.sharedBackgroundVisibility(.hidden)
}
```

`.badge(count)` on a toolbar button adds a notification indicator; toolbar `Menu`s support SF Symbol icons with consistent placement. Source: [WWDC25 323](https://developer.apple.com/videos/play/wwdc2025/323/).

**Do-not:** don't add your own `Color`/`Material` behind bar items — it fights the automatic scroll-edge effect (§2.7). Let the bar be glass.

### 2.4 Sheets & `.presentationDetents`

Sheets get a **glass background that fluidly transitions between detent heights** for free. Just declare detents:

```swift
.sheet(isPresented: $showSelection) {
    SelectionList()
        .presentationDetents([.height(180), .medium, .large])
}
```

**Critical do-not:** **remove custom `.presentationBackground`.** Setting `.presentationBackground(.thickMaterial)` (or any color) **overrides and breaks** the automatic Liquid Glass sheet background. This is a common migration bug. If you had one pre-26, delete it. Source: [WWDC25 323](https://developer.apple.com/videos/play/wwdc2025/323/).

For Eos's SpawnSheet / AskUserSheet: use `[.medium, .large]` (or `.height(…)` for a compact composer), and **do not** set a background.

### 2.5 Tab bars

The tab bar floats as glass. Two opt-in behaviors matter for a chat app:

```swift
TabView {
    Tab("Fleet", systemImage: "square.stack") { FleetView() }
    Tab(role: .search) { SearchView() }        // dedicated search page (§2.6)
}
.tabBarMinimizeBehavior(.onScrollDown)          // collapse when scrolling to maximize content
.tabViewBottomAccessory {                        // persistent control above the tab bar
    NowRunningAccessory()                        // e.g. a mini "active worker" strip
}
```

`tabViewBottomAccessory` is glass and reads its placement via `@Environment(\.tabViewBottomAccessoryPlacement)` (`.inline` compact vs. expanded) so you can render a compact vs. full layout. Eos is currently a `NavigationStack`, not tabs — the accessory pattern is only relevant if the redesign moves to tabs.

### 2.6 Search

`.searchable` adapts to the platform automatically:
- iPhone: field drops to the **bottom** of the screen (thumb-reachable, glassy).
- iPad/Mac: **top-trailing**.
- System may minimize it to a toolbar button when space is tight.

```swift
.searchable(text: $query)                     // adaptive placement, free glass
.searchToolbarBehavior(.minimize)             // opt in: collapse to a button if search is secondary

// Multi-tab apps: a dedicated search tab that replaces the tab bar with the field on selection
Tab(role: .search) { NavigationStack { SearchResults() } }
```

### 2.7 Scroll-edge effect

Where content scrolls under a glass bar, SwiftUI applies an automatic **scroll-edge effect** — a subtle blur+fade keeping bar controls legible over any content. **It is free.** Only tune it if you have a dense UI:

```swift
ScrollView { … }
    .scrollEdgeEffectStyle(.soft, for: .top)   // .soft = gentle blur; .hard = crisper cutoff
```

`.soft` is a subtle blurred edge; `.hard` is a sharper transition for dense/tabular content. Confirmed at [`ScrollEdgeEffectStyle.soft`](https://developer.apple.com/documentation/swiftui/scrolledgeeffectstyle/soft) (accessed 2026-07-09).

**Do-not (repeat):** remove any manual gradient/darkening you added behind bars pre-26 — it doubles up with this effect and looks muddy.

---

## 3. A modern glassy chat/agent app shell (Eos)

This section is the prescriptive part: how to assemble Eos's screens so glass reads as intentional, not stacked. Anchor rule throughout: **content scrolls; glass floats above it; never glass-on-glass.**

### 3.1 Layering contract

```
┌─────────────────────────────────────────┐
│  NAVIGATION LAYER  (Liquid Glass)         │  ← bars, sidebar, sheets, FAB, composer
│    · floats above, samples the content    │
├─────────────────────────────────────────┤
│  CONTENT LAYER     (opaque / paper)       │  ← transcript, fleet list, cards of text
│    · NOT glass; this is what glass samples│
└─────────────────────────────────────────┘
```

If a card on the content layer is also glass, it will "collide" with the floating bar's glass (both sampling, inconsistent). So Eos's **message cards and fleet rows are paper surfaces (doc 02 §1), not glass.** Glass is reserved for chrome. Source: [createwithswift — navigation vs content layer](https://www.createwithswift.com/liquid-glass-redefining-design-through-hierarchy-harmony-and-consistency/) (accessed 2026-07-09).

### 3.2 Floating glass composer (input bar)

The composer is the archetypal custom glass surface. Pattern: a `GlassEffectContainer` holding the text field + inline send, pinned to the bottom via **`safeAreaInset(edge: .bottom)`** (so the scroll content insets correctly and the keyboard pushes it up — see §4).

```swift
struct WorkerDetailView: View {
    @State private var draft = ""
    @FocusState private var composerFocused: Bool
    @Namespace private var glass

    var body: some View {
        ScrollView {
            LazyVStack { /* transcript blocks — paper, not glass */ }
        }
        .defaultScrollAnchor(.bottom)
        .scrollDismissesKeyboard(.interactively)          // §4.3
        .safeAreaInset(edge: .bottom) {                    // §4.1 — the correct anchor
            GlassEffectContainer(spacing: 8) {
                HStack(spacing: 8) {
                    TextField("Message", text: $draft, axis: .vertical)
                        .focused($composerFocused)
                        .textFieldStyle(.plain)
                        .padding(.horizontal, 14).padding(.vertical, 10)
                        .glassEffect(in: .capsule)         // the field's own glass pill
                        .glassEffectID("field", in: glass)

                    Button {
                        send(draft); draft = ""
                    } label: {
                        Image(systemName: "arrow.up")
                    }
                    .buttonStyle(.glassProminent)           // brand-tinted send (§7)
                    .buttonBorderShape(.circle)
                    .glassEffectID("send", in: glass)
                    .disabled(draft.isEmpty)
                }
                .padding(.horizontal, 12).padding(.bottom, 8)
            }
        }
    }
}
```

Notes:
- The composer and send live in **one** `GlassEffectContainer` so they sample coherently and can morph if you later animate the send in/out.
- **Do not** wrap the container in another glass/material background — that's glass-on-glass.
- `axis: .vertical` lets the field grow with multi-line prompts; the `safeAreaInset` re-measures and content stays clear.

### 3.3 Floating "+" action (FAB) with expand-morph

A circular glass "+" that morphs open into its actions, using §1.4:

```swift
@State private var open = false
@Namespace private var fab

GlassEffectContainer(spacing: 16) {
    VStack(spacing: 12) {
        if open {
            fabAction("Spawn", "plus.circle")   .glassEffectID("spawn", in: fab)
            fabAction("Scan",  "qrcode.viewfinder").glassEffectID("scan", in: fab)
        }
        Button { withAnimation(.bouncy) { open.toggle() } } label: {
            Image(systemName: open ? "xmark" : "plus")
        }
        .buttonStyle(.glassProminent)
        .buttonBorderShape(.circle)
        .glassEffectID("fab", in: fab)          // actions grow out of this
    }
    .padding()
}
```

### 3.4 Glass sidebar / drawer

- Prefer **`NavigationSplitView`** for the free floating glass sidebar (§2.1).
- If keeping Eos's custom `SidebarContainer` drawer, give the drawer panel **one** `.glassEffect(in: .rect(cornerRadius: …))` and let the dimmed content behind it show through — **do not** also put glass on the rows inside it (rows are content). The device chip / list items sit on the drawer's single glass surface.

### 3.5 Cards & rows

Fleet rows, transcript message blocks, pending-decision cards: **content layer → opaque paper surfaces** (doc 02 tokens), *not* glass. This is deliberate restraint. A screen where the bar, the composer, *and* every card are glass is exactly the "blur pile" Apple warns against. Glass earns its emphasis by being rare.

### 3.6 "Don't over-glass" checklist for Eos

- One glass bar (top or bottom) + one glass composer/FAB per screen is plenty.
- Message bubbles, list rows, form fields inside sheets → **not** glass.
- Every cluster of adjacent glass → wrapped in a `GlassEffectContainer`.
- Tint applied to **at most one** element per screen (the primary action) — §7.

---

## 4. Safe area + scroll + keyboard (the bug-prone zone)

This section is the fix for the current bugs. The mistakes almost always come from reaching for `.ignoresSafeArea` when the right tool is `safeAreaInset`, and from missing keyboard-dismiss affordances.

### 4.1 The decision table: which safe-area tool

| Goal | Use | Do **not** use |
|---|---|---|
| A **background** to bleed under bars/notch/home-indicator | `.ignoresSafeArea()` on the **background layer only** (e.g. in a `ZStack`), or `.backgroundExtensionEffect()` on an image | `.ignoresSafeArea()` on the whole screen / on content |
| A **floating bar/composer** pinned to an edge that content must not hide behind | `.safeAreaInset(edge: .bottom)` (or `.top`) | absolute `.offset`, manual `Spacer()` + `VStack`, `.padding(.bottom, 34)` magic numbers |
| A **sheet's** own background | nothing — it's automatic glass | `.presentationBackground(…)` |
| Extra breathing room that respects the safe area | `.safeAreaPadding(…)` | raw `.padding` at screen edges |

**The core rule:** `.ignoresSafeArea` belongs to **backgrounds**, `.safeAreaInset` belongs to **foreground chrome**. Mixing them up is the source of "content hides under the composer" and "the bar overlaps the notch."

**Correct full-bleed-background-plus-safe-content pattern** (from Apple's own sign-in example, [Adding a background to your view](https://developer.apple.com/documentation/swiftui/adding-a-background-to-your-view), accessed 2026-07-09):

```swift
ZStack {
    backgroundGradient
        .ignoresSafeArea()          // ONLY the background bleeds edge-to-edge
    VStack {
        // real content — stays within the safe area, moves with the keyboard
    }
}
```

### 4.2 Full-bleed backgrounds under glass

- For a background **color/gradient**: `.ignoresSafeArea()` on that layer in a `ZStack` (above).
- For a background **image/header** that glass floats over: `.backgroundExtensionEffect()` (§1.6) — it bleeds the image under the bars so the glass has rich content to sample, without clipping.
- Then let the *content* obey the safe area normally. Do not push content into the unsafe region to "match" the background.

### 4.3 Keyboard avoidance

SwiftUI moves content out of the keyboard's way automatically **when the layout uses the safe area** — which is exactly why the composer must be attached with `safeAreaInset(edge: .bottom)` (§3.2). With that, the composer rides up on top of the keyboard and the scroll content insets to match. **No manual keyboard-height observers, no `GeometryReader` hacks.**

If a specific background must *not* move with the keyboard, scope `.ignoresSafeArea(.keyboard)` to that background only (there's a dedicated `SafeAreaRegions.keyboard`):

```swift
backgroundImage.ignoresSafeArea(.keyboard, edges: .bottom)   // background stays put; content still avoids keyboard
```

### 4.4 Keyboard **dismiss** — the idiomatic patterns

Provide **at least two** dismiss affordances (scroll-to-dismiss + an explicit control). Recommended stack for Eos's chat composer:

**(a) Scroll to dismiss** — the primary gesture in a chat transcript:

```swift
ScrollView { … }
    .scrollDismissesKeyboard(.interactively)   // keyboard follows the drag — best for chat
// or .immediately  → dismiss the instant a scroll starts
// or .automatic     → platform default
```

`.interactively` lets the user drag the keyboard down with the scroll (the Messages feel); `.immediately` dismisses on any scroll start. Confirmed at [`scrollDismissesKeyboard(_:)`](https://developer.apple.com/documentation/swiftui/view/scrolldismisseskeyboard(_:)) (accessed 2026-07-09).

**(b) `@FocusState` — programmatic dismiss** (send button, tap-to-dismiss, "Escape"):

```swift
@FocusState private var composerFocused: Bool
// resign the keyboard from anywhere:
composerFocused = false
```

**(c) Tap-anywhere-to-dismiss** — layer a background tap that clears focus:

```swift
.contentShape(Rectangle())
.onTapGesture { composerFocused = false }
// Apply to the scroll content / transcript background, not over interactive controls.
```

**(d) A keyboard toolbar "Done"** — explicit, always-available:

```swift
.toolbar {
    ToolbarItemGroup(placement: .keyboard) {
        Spacer()
        Button("Done") { composerFocused = false }
    }
}
```

`ToolbarItemPlacement.keyboard` is the dedicated placement for the accessory bar above the keyboard (confirmed at [`ToolbarItemPlacement.keyboard`](https://developer.apple.com/documentation/swiftui/toolbaritemplacement), accessed 2026-07-09).

**Recommended for Eos:** `.scrollDismissesKeyboard(.interactively)` on the transcript **+** `@FocusState` cleared on send **+** a keyboard-toolbar **Done**. That trio covers gesture, action, and explicit dismissal without magic numbers.

---

## 5. Color / tint with glass

### 5.1 Brand accent tint

Two ways the Eos coral accent (doc 02 §1) meets glass:

1. **Tinted glass** — `.glassEffect(.regular.tint(EosColor.coral))`. The tint is rendered as a **vibrant** wash that still adapts to content behind it (not a flat fill). Use for a single emphasized floating element.
2. **Prominent glass button** — `.buttonStyle(.glassProminent)` picks up the ambient `.tint(EosColor.coral)`, giving a filled brand-colored primary action (Send, Approve).

```swift
// Primary action, brand-tinted:
Button("Approve") { approve() }
    .buttonStyle(.glassProminent)
    .tint(EosColor.coral)

// Emphasized status chip (meaningful color, not decoration):
StateChip(.running)
    .glassEffect(.regular.tint(.green))
```

**Tint sparingly.** Apple's guidance: use tint to highlight **primary** elements only; tinting everything flattens hierarchy and defeats the purpose. One tinted element per screen. Source: [createwithswift](https://www.createwithswift.com/liquid-glass-redefining-design-through-hierarchy-harmony-and-consistency/) (accessed 2026-07-09).

### 5.2 Dark vs. light, vibrancy

- **Regular glass adapts automatically** to light and dark, and to colorful vs. plain content behind it — that's the whole point of the material. You generally do **not** branch on `colorScheme` for glass.
- Foreground content over glass uses **vibrant, adaptive** text/symbol colors chosen by SwiftUI. Prefer **monochrome SF Symbols** on glass; add color only to convey meaning. Multi-color/filled symbols on glass add visual noise.
- **Revisit doc 02's "force light scheme":** Liquid Glass is designed to shine in both schemes. Locking light mode is a *product/aesthetic* decision (the warm-paper look), not a technical constraint. If we keep the lock, glass still works; if we allow dark, glass adapts for free. Flag this for the redesign owner.

### 5.3 Accessibility (must-do, wire in up front)

Adopting glass **automatically** responds to the system accessibility settings — you get sensible fallbacks for free:

- **Reduce Transparency** → glass **frosts** (much more opaque) for legibility.
- **Increase Contrast** → starker colors + borders on glass.
- **Reduce Motion** → glass morph/shimmer animations are toned down.

For **custom** surfaces where you want to *fully* drop glass (e.g. a text-critical panel) when transparency is reduced, branch on the environment value:

```swift
@Environment(\.accessibilityReduceTransparency) private var reduceTransparency

myPanel
    .glassEffect(reduceTransparency ? .identity : .regular)   // .identity = no glass, opaque fallback
// or use the isEnabled overload:
    .glassEffect(.regular, in: .capsule, isEnabled: !reduceTransparency)
```

`.identity` applies **no** glass without forcing a layout recalculation, so it's the clean toggle target. **Wire Reduce Transparency handling in from the start** — retrofitting it later exposes every place the UI silently assumed translucency for contrast. Sources: [WWDC25 323](https://developer.apple.com/videos/play/wwdc2025/323/); accessibility behavior corroborated by community reference [conorluddy/LiquidGlassReference](https://github.com/conorluddy/LiquidGlassReference) (accessed 2026-07-09).

> Note: iOS 26.1+ also added a system-wide "tinted"/less-transparent Liquid Glass appearance the *user* can pick (Six Colors, 2025-11). Your app inherits it automatically — another reason not to hard-code opacity.

---

## 6. Gotchas / do-nots (consolidated)

Pulled from Apple's WWDC25 guidance and corroborating references. The load-bearing ones for Eos are bolded.

**Design**
- **Glass is for the navigation layer, not the content layer.** Don't glass lists, tables, transcript bubbles, or media — glass on content collides with the floating chrome that samples it.
- **Never stack glass on glass.** Overlapping/adjacent glass without a shared `GlassEffectContainer` samples inconsistently and reads as a blur pile. Fix with a container + spacing + restraint.
- **Don't mix `.regular` and `.clear`** in the same context; don't use `.clear` without a dimming layer + bold foreground. (For Eos: use `.regular` only.)
- **Don't tint everything.** Reserve tint for the one primary action per screen; overuse kills hierarchy.
- Don't use color/glass as the *sole* signal of meaning — pair with text/shape (also an accessibility requirement).
- Prefer **monochrome** SF Symbols on glass; color only to convey meaning.

**Technical**
- **Don't emit multiple `.glassEffect` outside a `GlassEffectContainer`** — inefficient and no morphing, even for "just two buttons."
- **Don't set `.presentationBackground` on sheets** — it overrides the automatic glass sheet background.
- **Don't add custom backgrounds/darkening behind bar items** — it fights the automatic scroll-edge effect.
- **Container `spacing` > inner layout spacing** makes glass merge at rest — usually not what you want (§1.3).
- **`.ignoresSafeArea` is for backgrounds, `.safeAreaInset` is for floating chrome** — the #1 source of safe-area/keyboard bugs (§4.1).
- Don't hand-observe keyboard height / use `GeometryReader` for the composer — `safeAreaInset` + auto keyboard avoidance handles it (§4.3).
- Don't hard-code color schemes or opacity — glass adapts; the user can also change global glass appearance.
- `.glassProminent` + `.circle`: some builds show clipping artifacts; add `.clipShape(Circle())` if you see them (community-reported workaround, verify on iOS 27 test device). Source: [conorluddy/LiquidGlassReference](https://github.com/conorluddy/LiquidGlassReference).

**Performance**
- Always wrap multi-element glass in a `GlassEffectContainer` (shared shape set = fewer passes).
- Avoid **continuous/indefinite** animations on glass (e.g. a forever-spinning glass spinner) and glass over highly-animated backgrounds — both are expensive.
- Profile on the **iOS 27 test device**; glass is heavier than flat UI. Don't scatter many independent containers without measuring.

Sources for this section: [WWDC25 323 — Build a SwiftUI app with the new design](https://developer.apple.com/videos/play/wwdc2025/323/); [Applying Liquid Glass to custom views](https://developer.apple.com/documentation/SwiftUI/Applying-Liquid-Glass-to-custom-views); [Adopting Liquid Glass](https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass); [createwithswift — Hierarchy, Harmony, Consistency](https://www.createwithswift.com/liquid-glass-redefining-design-through-hierarchy-harmony-and-consistency/). All accessed 2026-07-09.

---

## 7. Concentricity (bonus — for perfectly nested corners)

When a glass control (or any shape) nests inside a rounded container, use the **concentric** corner so the inner radius tracks the container across devices/window shapes automatically — no guessed radii:

```swift
CustomControl()
    .glassEffect(in: .rect(corner: .containerConcentric))
// or as a background:
    .background(.tint, in: .rect(corner: .containerConcentric))
```

Source: [WWDC25 323](https://developer.apple.com/videos/play/wwdc2025/323/) (accessed 2026-07-09).

---

## 8. API quick-reference card

| API | Purpose | §|
|---|---|---|
| `.glassEffect(_ glass: Glass = .regular, in: some Shape = Capsule)` | Apply glass to a custom view | 1.1 |
| `.glassEffect(_, in:, isEnabled:)` | Conditional glass (accessibility toggle) | 5.3 |
| `Glass.regular` / `.clear` | Material variant (use `.regular`) | 1.2 |
| `Glass.tint(_ color: Color?)` | Vibrant color wash (sparingly) | 1.2 / 5.1 |
| `Glass.interactive(_ isEnabled: Bool = true)` | Touch-reactive glass (iOS) | 1.2 |
| `GlassEffectContainer(spacing:) { }` | Shared sampling region + morphing; wrap all adjacent glass | 1.3 |
| `.glassEffectID(_:in:)` + `@Namespace` | Morph one glass shape into another | 1.4 |
| `.glassEffectUnion(id:in:)` | Statically fuse a group of shapes | 1.4 |
| `.buttonStyle(.glass)` / `.glassProminent` | Glass buttons; prominent uses `.tint` | 1.5 |
| `.backgroundExtensionEffect(isEnabled:)` | Bleed a background beyond safe area for glass to sample | 1.6 / 4.2 |
| `ToolbarSpacer(.fixed / .flexible, placement:)` | Split/space toolbar glass groups | 2.3 |
| `.sharedBackgroundVisibility(.hidden)` | Isolate a toolbar item into a bare group | 2.3 |
| `.presentationDetents([…])` | Multi-height glass sheets (no custom bg!) | 2.4 |
| `.tabBarMinimizeBehavior(.onScrollDown)` | Collapse tab bar on scroll | 2.5 |
| `.tabViewBottomAccessory { }` | Persistent glass strip above tab bar | 2.5 |
| `.searchable` + `.searchToolbarBehavior(.minimize)` | Adaptive glass search | 2.6 |
| `.scrollEdgeEffectStyle(.soft / .hard, for:)` | Tune scroll-edge legibility | 2.7 |
| `.safeAreaInset(edge:)` | Pin floating chrome; content insets + keyboard avoidance | 4.1 |
| `.ignoresSafeArea()` | Backgrounds ONLY | 4.1 |
| `.scrollDismissesKeyboard(.interactively / .immediately)` | Swipe-to-dismiss keyboard | 4.4 |
| `@FocusState` | Programmatic keyboard dismiss | 4.4 |
| `ToolbarItemPlacement.keyboard` | Keyboard accessory "Done" bar | 4.4 |
| `.rect(corner: .containerConcentric)` | Auto-nested concentric corners | 7 |
| `@Environment(\.accessibilityReduceTransparency)` | Detect Reduce Transparency for `.identity` fallback | 5.3 |

---

## Sources

All accessed **2026-07-09**.

**Apple — primary**
- Build a SwiftUI app with the new design — WWDC25 session 323: https://developer.apple.com/videos/play/wwdc2025/323/
- Meet Liquid Glass — WWDC25 session 219: https://developer.apple.com/videos/play/wwdc2025/219/
- Applying Liquid Glass to custom views: https://developer.apple.com/documentation/SwiftUI/Applying-Liquid-Glass-to-custom-views
- Landmarks: Building an app with Liquid Glass: https://developer.apple.com/documentation/SwiftUI/Landmarks-Building-an-app-with-Liquid-Glass
- Adopting Liquid Glass (Technology Overviews): https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass
- `glassEffect(_:in:)`: https://developer.apple.com/documentation/swiftui/view/glasseffect(_:in:)
- `Glass`: https://developer.apple.com/documentation/swiftui/glass · `.tint(_:)`: https://developer.apple.com/documentation/swiftui/glass/tint(_:) · `.interactive(_:)`: https://developer.apple.com/documentation/swiftui/glass/interactive(_:)
- `GlassEffectContainer`: https://developer.apple.com/documentation/swiftui/glasseffectcontainer
- `glassEffectID(_:in:)`: https://developer.apple.com/documentation/swiftui/view/glasseffectid(_:in:)
- `GlassEffectTransition`: https://developer.apple.com/documentation/swiftui/glasseffecttransition
- `backgroundExtensionEffect(isEnabled:)`: https://developer.apple.com/documentation/swiftui/view/backgroundextensioneffect(isenabled:)
- `PrimitiveButtonStyle.glassProminent`: https://developer.apple.com/documentation/swiftui/primitivebuttonstyle/glassprominent
- `ScrollEdgeEffectStyle.soft`: https://developer.apple.com/documentation/swiftui/scrolledgeeffectstyle/soft
- `scrollDismissesKeyboard(_:)`: https://developer.apple.com/documentation/swiftui/view/scrolldismisseskeyboard(_:)
- `ToolbarItemPlacement.keyboard`: https://developer.apple.com/documentation/swiftui/toolbaritemplacement
- `safeAreaInset(edge:…)`: https://developer.apple.com/documentation/swiftui/view/safeareainset(edge:alignment:spacing:content:)
- Adding a background to your view (safe-area + keyboard pattern): https://developer.apple.com/documentation/swiftui/adding-a-background-to-your-view
- Human Interface Guidelines — Materials: https://developer.apple.com/design/human-interface-guidelines/materials

**Secondary — design principles & corroboration**
- createwithswift — Liquid Glass: Hierarchy, Harmony, Consistency: https://www.createwithswift.com/liquid-glass-redefining-design-through-hierarchy-harmony-and-consistency/
- createwithswift — Exploring a new visual language: Liquid Glass: https://www.createwithswift.com/exploring-a-new-visual-language-liquid-glass/
- conorluddy/LiquidGlassReference (community iOS 26 reference — gotchas, fallbacks, workarounds): https://github.com/conorluddy/LiquidGlassReference
- Six Colors — "Soaping up Liquid Glass" (iOS 26.1 user glass-appearance control), 2025-11: https://sixcolors.com/post/2025/11/soaping-up-liquid-glass-less-transparency-more-contrast/
- Appcircle — WWDC25: Build a SwiftUI App with the New Design: https://appcircle.io/blog/wwdc-25-build-a-swiftui-app-with-the-new-design

> **Verification note.** Every API *signature* and every "free vs. opt-in" claim in §§0–2, 4, 7–8 is sourced from Apple docs / WWDC25 323. Two items are community-sourced and flagged inline for on-device verification against the iOS 27 test build: (a) the `.glassProminent` + `.circle` clipping workaround (§6), and (b) exact accessibility-fallback intensities (§5.3) — the *behavior* (frost on Reduce Transparency, etc.) is Apple-stated; precise appearance should be eyeballed on device.
