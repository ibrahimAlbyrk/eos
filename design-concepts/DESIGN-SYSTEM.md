# Eos Design System — brief for menu-bar UI work

Extracted verbatim from the real app, not generic glassmorphism. Source of truth:
`app/ui/src/styles.css` (8325 lines), `app/ui/index.html`, and the brand SVGs in
`assets/`. Every value below is copied from that CSS — where a value genuinely
isn't defined in the app, it's flagged `[not in source]`.

The app ships **two themes**: dark (`:root` default) and light (warm cream,
`html[data-theme="light"]`). Tokens are CSS custom properties; soft variants
derive from base tokens via `color-mix`, so overriding a base token cascades.

---

## 1. Color palette

All values are exact, copied from `styles.css:65-197`.

### Dark (default — `:root`, `color-scheme: dark`)

| Role | Token | Value |
|---|---|---|
| App background (center/full-bleed) | `--bg` | `#1a1a1a` |
| Surface 1 | `--surface` | `#1f1f1f` |
| Surface 2 (cards, viewers) | `--surface-2` | `#252525` |
| Surface 3 (raised: tab track, pills) | `--surface-3` | `#2c2c2c` |
| Border (hairline) | `--border` | `#262626` |
| Border strong (hover/focus frame) | `--border-strong` | `#353535` |
| Text primary | `--fg` | `#ebebeb` |
| Text mid | `--fg-mid` | `#c4c4c4` |
| Text dim | `--fg-dim` | `#8a8a8a` |
| Text faint (placeholder, labels) | `--fg-faint` | `#5a5a5a` |
| **Accent (primary)** | `--accent` | **`#6ea4e8`** (cornflower / dawn blue) |
| Accent soft (fills, rings) | `--accent-soft` | `color-mix(in srgb, var(--accent) 13%, transparent)` |
| Accent hover | `--accent-hover` | `#8ab9f0` |
| On-accent (text over accent) | `--on-accent` | `#0a0a0a` |
| **Success / running** | `--ok` | **`#67c084`** (green) |
| Warn / thinking / needs-input | `--warn` | `#d4a55a` (amber-tan) |
| **Failure** | `--err` | **`#d97670`** (muted red) |
| Git / diff-add | `--git` | `#67c084` |
| Git soft | `--git-soft` | `color-mix(in srgb, var(--git) 14%, transparent)` |
| Amber (terminal mode) | `--amber` | `#e8a838` |
| Violet (accent 2) | `--violet` | `#c8a2ff` |
| Solid button bg / fg | `--solid-btn-bg` / `--solid-btn-fg` | `#e8e8e8` / `#1a1a1a` |
| User bubble bg / fg | `--bubble-user-bg` / `--bubble-user-fg` | `#313130` / `#e2e1da` |
| Queued bg / fg | `--queued-bg` / `--queued-fg` | `#212b35` / `#0099ff` |

### Light (`html[data-theme="light"]`, warm cream, `color-scheme: light`)

| Role | Token | Value |
|---|---|---|
| App background | `--bg` | `#f6f1e6` |
| Surface 1/2/3 | `--surface` / `-2` / `-3` | `#faf6ed` / `#fdfaf3` / `#ffffff` |
| Border / strong | `--border` / `--border-strong` | `#e6dfd0` / `#d3c9b4` |
| Text primary→faint | `--fg` … `--fg-faint` | `#2d2a23` / `#4f4a3c` / `#6b6555` / `#7d7665` |
| **Accent** | `--accent` | **`#0969da`** (GitHub blue) |
| Accent hover / on-accent | `--accent-hover` / `--on-accent` | `#0550ae` / `#ffffff` |
| **Success / running** | `--ok` | `#1a7f37` |
| Warn | `--warn` | `#9a6700` |
| **Failure** | `--err` | `#cf222e` |
| Amber / violet | `--amber` / `--violet` | `#bc4c00` / `#8250df` |

### RGB channel tokens (drive overlays + glass — split so light mode tunes independently)

| Token | Dark | Light | Used for |
|---|---|---|---|
| `--tint` | `255, 255, 255` | `60, 45, 20` | neutral hover/active overlays: `rgba(var(--tint), 0.06)` |
| `--glass` | `30, 30, 30` | `248, 242, 230` | translucent panel backgrounds |
| `--rim` | `255, 255, 255` | `255, 255, 255` | glass rim/highlight gradients |
| `--ink` | `0, 0, 0` | `255, 255, 255` | inner-shadow / inset darkening |

**Semantic shorthand for menu-bar status:** running = `--ok` green, completion =
`--ok` green check, failure = `--err` red, needs-input/thinking = `--warn` amber,
neutral/idle = `--fg-dim` / `--fg-faint`. The accent blue `#6ea4e8` is the brand/
attention color (selection rings, attention pulses), **not** the running color.

---

## 2. The liquid-glass recipe

The app has one canonical glass card recipe, reused everywhere (`.side-island`,
`.q-card`, `.glass-pop`, `.update-card`, `.pane-picker`, `.page-find`, composer).
There are **three densities**, keyed off the blur scale.

### Blur + saturation scale (`styles.css:78-80`)
```css
--blur-sm: 8px;
--blur-md: 14px;
--blur-lg: 22px;
```
- Light glass (sidebar islands, composer): `blur(var(--blur-md)) saturate(140-150%)`
- Heavy glass (popovers, dialogs, question cards): `blur(var(--blur-lg)) saturate(170%)`
- Subtle (hover pills): `blur(var(--blur-sm))`

### Canonical heavy-glass card (copy this — from `.q-card` / `.pane-picker`)
```css
.glass-card {
  position: relative;
  background: rgba(var(--glass), 0.5);                    /* dark: rgba(30,30,30,.5) */
  backdrop-filter: blur(22px) saturate(170%);
  -webkit-backdrop-filter: blur(22px) saturate(170%);
  border-radius: 12px;
  box-shadow:
    0 8px 24px rgba(0, 0, 0, 0.28),
    0 2px 6px rgba(0, 0, 0, 0.18);
}
/* The rim: 1px gradient border via mask-composite (inner highlight + hairline).
   This is THE signature — a diagonal light-to-faint stroke, brighter top-left. */
.glass-card::after {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  border-radius: inherit;
  padding: 1px;
  background: linear-gradient(135deg,
    rgba(var(--rim), 0.36),         /* bright top-left highlight */
    rgba(var(--rim), 0.07) 38%,
    rgba(var(--rim), 0.07) 62%,
    rgba(var(--rim), 0.22)) border-box; /* faint bottom-right */
  -webkit-mask:
    linear-gradient(#000, #000) content-box,
    linear-gradient(#000, #000);
  -webkit-mask-composite: xor;
          mask-composite: exclude;
}
/* Content must ride above the rim */
.glass-card > * { position: relative; z-index: 1; }
```

### Lighter sidebar-island glass (`.side-island`, `styles.css:493-520`)
```css
background: rgba(var(--glass), 0.42);
backdrop-filter: blur(14px) saturate(140%);
border-radius: 12px;
box-shadow: 0 4px 16px rgba(0,0,0,0.18), 0 1px 3px rgba(0,0,0,0.12);
/* same ::after rim, but slightly dimmer is acceptable */
```

### Composer glass (`.c-row2`, `styles.css:3517-3585`)
```css
background: rgba(var(--glass), 0.44);
backdrop-filter: blur(14px) saturate(150%);
border-radius: 8px;
box-shadow: 0 4px 14px rgba(0,0,0,0.18), 0 1px 3px rgba(0,0,0,0.12);
/* rim ::after uses a dimmer stop set: 0.19 / 0.04 / 0.04 / 0.12 */
```

### Hover-pill inner glow (subtle pressed-glass, `.sb-settings__btn:hover`)
```css
background: rgba(var(--tint), 0.05);
backdrop-filter: blur(8px);
box-shadow:
  inset 0 1px 1px rgba(var(--ink), 0.20),
  inset 0 0 0 1px rgba(var(--tint), 0.09);
```

### Corner radii (the app's radius scale)
| Use | Radius |
|---|---|
| Glass cards / panels / viewers | `12px` (`--panel-radius`) |
| Composer, tab track, segmented pills | `8px` |
| Inputs, small popover rows | `5–7px` |
| Buttons, nav items, icon buttons | `4–6px` |
| Chips, `kbd`, code inline | `3–4px` |
| Dots / traffic lights | `50%` |

### Status-glow pattern (running/success dots — reuse in the menu bar)
```css
/* a colored dot with a soft same-color halo */
box-shadow: 0 0 6px color-mix(in srgb, var(--ok) 55%, transparent);
/* ring variant (update dot) */
box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent);
```

**Menu-bar caveat:** native macOS menu-bar vibrancy is the OS material, not a CSS
`backdrop-filter`. To stay faithful, mimic the rim + shadow stack above over the
system vibrancy, keeping `rgba(var(--glass), 0.5)` translucency and the `135deg`
rim gradient.

---

## 3. Typography

```css
--font-ui:   "Plus Jakarta Sans Variable", -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
--font-mono: "JetBrains Mono Variable", ui-monospace, SFMono-Regular, monospace;
```
- **Base 14px**, `line-height: 1.55`, `letter-spacing: -0.005em`, antialiased,
  `font-synthesis: none` (variable fonts cover all weights — never synthesize).
- Variable fonts; weights used in CSS: **400, 450, 500, 600, 700**. UI chrome is
  mostly 500; primary text 400–450; emphasis/avatars 600.

### Size scale (rem so `html{font-size}` scales the whole UI; px at 16px root)
| Token | rem | px | Use |
|---|---|---|---|
| `--text-xs` | 0.75 | 12 | labels, kbd, counts, mono chips (pixelation floor) |
| `--text-sm` | 0.8125 | 13 | nav, secondary, most UI |
| `--text-base` | 0.875 | **14** | body / default |
| `--text-md` | 0.9375 | 15 | |
| `--text-lg` | 1.0 | 16 | |
| `--text-xl` | 1.0625 | 17 | |
| `--text-2xl` | 1.1875 | 19 | |
| `--text-3xl` | 1.375 | 22 | headings |

- **Monospace** (`--font-mono`) is used for: counts, elapsed times, status text,
  section labels (uppercase, `letter-spacing: 0.1em`), kbd, code. Tabular counts
  in the menu bar should use this — it's the app's data/telemetry voice.
- Uppercase micro-labels: `font-size: 12px; text-transform: uppercase;
  letter-spacing: 0.1em; color: var(--fg-faint); font-family: mono`.

---

## 4. Motion language

Crisp, short, compositor-only (transform/opacity). Layout properties are never
animated (see `styles.css:301` — grid columns open instantly; motion lives on
content). Honors `@media (prefers-reduced-motion: reduce)` everywhere.

### Durations (actual, by frequency of use)
- **120–160ms** — hover/color/background micro-transitions (the default tempo).
- **180–250ms** — element enter/rise, panel open, popover/card in.
- **280–320ms** — larger layout-feel shifts (sidebar slide, tab indicator, ring fills).

### Easings actually in the CSS
| Easing | Where |
|---|---|
| `ease` | the workhorse — most transitions (`160ms ease`, `200ms ease`) |
| `cubic-bezier(0.2, 0.7, 0.3, 1)` | **the signature "rise"** — card/pill/tooltip enter, panel open; gentle overshoot-free settle |
| `cubic-bezier(0.4, 0, 0.2, 1)` | standard material — tab indicator slide, ring stroke, sliders |
| `ease-in-out` | all looping pulses (attention, breathing dots) |
| `linear` | spinners, shimmer sweeps |

### Signature keyframes to reuse in the menu bar
```css
/* card / pill rise-in (the app's "appear") */
@keyframes q-rise { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:none; } }
/* duration 180ms ease-out */

/* attention / running breath — soft opacity pulse */
@keyframes ag-pulse { 50% { opacity: 0.45; } }   /* 1.4s ease-in-out infinite */

/* attention blink with accent drop-shadow (collapsed sidebar wanting attention) */
@keyframes attention-blink {
  0%,100% { opacity:1; filter: drop-shadow(0 0 3px color-mix(in srgb, var(--accent) 65%, transparent)); }
  50%     { opacity:.4; filter: drop-shadow(0 0 0 transparent); }
}                                                /* 1.4s ease-in-out infinite */

/* pane needs-input edge pulse (warn) and attention edge pulse (accent) —
   border-color + inset ring oscillate; good model for a status item edge glow */

/* shimmer sweep (skeletons, ticker) */
@keyframes ti-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
/* 8s linear infinite over a gradient background-size:200% */

/* check-draw — stroke a checkmark on completion */
@keyframes tt-check-draw { to { stroke-dashoffset: 0; } }  /* 260ms ease-out */
```

**Feel:** calm and first-party by default; motion only appears when something is
actually happening (rings spin only while work runs, equalizers still at idle).
Pulses are slow (1.3–1.8s) and low-amplitude. Nothing bounces or flares
decoratively — every animation maps to a state.

---

## 5. The logo

### Primary app asset (raster)
- **Path:** `app/ui/public/logo.png`
- **Format:** PNG, **512 × 512**, 8-bit RGBA, ~245 KB
- **Referenced:** favicon in `app/ui/index.html:6` (`<link rel="icon" href="./logo.png">`);
  `app/build.sh` converts it (via `sips`/`iconutil`) into `AppIcon.icns` for the
  native macOS app — so the PNG is the single source of truth, the `.icns` derives.
- **NOT inline-ready.** For inline use it must be base64-data-URI'd:
  ```bash
  # macOS — produces a data: URI to paste into HTML/CSS
  printf 'data:image/png;base64,%s' "$(base64 -i app/ui/public/logo.png)"
  ```

### The vector mark (inline-SVG-ready — use this in mockups)
The brand mark is an **8-spoke radial "dawn star"** (Eos = goddess of dawn). It
lives as vector inside `assets/eos-banner-aurora-dark.svg` and
`assets/eos-divider-dark.svg`. Extracted and made standalone below — drop straight
into any HTML. Mark colors: white→`#e8f1ff`→`#a9cdf6`→`#5f93dd`→`#3f6fb5` radial
fill, with a `#6ea4e8` halo and a white→`#6ea4e8` core. (Matches the accent blue.)

```html
<!-- Eos dawn-star mark · standalone · scales to any size (set width/height) -->
<svg viewBox="-180 -180 360 360" width="40" height="40"
     xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Eos">
  <defs>
    <radialGradient id="eosStar" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="98">
      <stop offset="0"   stop-color="#ffffff"/>
      <stop offset="0.2" stop-color="#e8f1ff"/>
      <stop offset="0.5" stop-color="#a9cdf6"/>
      <stop offset="0.8" stop-color="#5f93dd"/>
      <stop offset="1"   stop-color="#3f6fb5"/>
    </radialGradient>
    <radialGradient id="eosHalo" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="168">
      <stop offset="0"    stop-color="#6ea4e8" stop-opacity="0.5"/>
      <stop offset="0.45" stop-color="#6ea4e8" stop-opacity="0.13"/>
      <stop offset="1"    stop-color="#6ea4e8" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="eosCore" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="30">
      <stop offset="0"   stop-color="#ffffff" stop-opacity="1"/>
      <stop offset="0.5" stop-color="#6ea4e8" stop-opacity="0.55"/>
      <stop offset="1"   stop-color="#6ea4e8" stop-opacity="0"/>
    </radialGradient>
    <filter id="eosBloom" x="-80%" y="-80%" width="260%" height="260%">
      <feGaussianBlur stdDeviation="7"/>
    </filter>
    <g id="eosSpokes" fill="url(#eosStar)">
      <rect x="-12" y="-98" width="24" height="86" rx="12" transform="rotate(0)"/>
      <rect x="-12" y="-98" width="24" height="86" rx="12" transform="rotate(45)"/>
      <rect x="-12" y="-98" width="24" height="86" rx="12" transform="rotate(90)"/>
      <rect x="-12" y="-98" width="24" height="86" rx="12" transform="rotate(135)"/>
      <rect x="-12" y="-98" width="24" height="86" rx="12" transform="rotate(180)"/>
      <rect x="-12" y="-98" width="24" height="86" rx="12" transform="rotate(225)"/>
      <rect x="-12" y="-98" width="24" height="86" rx="12" transform="rotate(270)"/>
      <rect x="-12" y="-98" width="24" height="86" rx="12" transform="rotate(315)"/>
    </g>
  </defs>
  <circle r="168" fill="url(#eosHalo)"/>
  <use href="#eosSpokes" filter="url(#eosBloom)" opacity="0.85"/>
  <use href="#eosSpokes"/>
  <circle r="26" fill="url(#eosCore)"/>
</svg>
```

**Usage / clear-space / on-dark vs on-light:**
- The mark is centered at origin; geometry spans r≈98 (spokes) with a halo to
  r≈168. The `viewBox="-180 -180 360 360"` already bakes in ~12px of clear space
  past the halo. Keep at least the halo radius (≈ mark-width × 0.85) clear around it.
- **On dark** (`#1a1a1a`): use as-is — the bloom + halo read as a glow. This is the
  default/native menu-bar-dark form.
- **On light** (`#f6f1e6`): the halo nearly vanishes; the gradient fill still reads.
  For a flat menu-bar-tint version, drop the bloom/halo and render the spokes in
  a single tint (`currentColor`) so it inherits the bar's near-black/near-white —
  matching first-party monochrome behavior (concept 01's approach).
- Light-banner variants exist at `assets/eos-banner-aurora-light.svg` and
  `assets/eos-divider-light.svg` if a pre-tuned light mark is wanted.
- Wordmark: lowercase **"eos"**, Plus Jakarta Sans 700, `letter-spacing: -3.4`
  (tight) at banner scale, color `#ededed` on dark.

---

## 6. Best of the three concepts (worth merging)

Skimmed `01-native-calm.html`, `02-alive-expressive.html`, `03-glanceable-pro.html`.
Strongest ideas, by author intent:

**From 01 · Native & Calm (the discipline floor):**
- **Right-edge-pinned reveal.** The status item grows *leftward* (right edge pinned
  to its slot) so neighbors and the popover never shift — true menu-bar behavior.
- **Semantic color only.** Idle/running are monochrome, inheriting the bar tint;
  color appears *only* for meaning — `--ok` green completion, `--err` red failure.
- **One easing for everything** — a single spring `cubic-bezier(.32,.72,0,1)` so
  width/fade/motion feel like one hand. (Pairs with the app's `0.2,0.7,0.3,1` rise.)
- **Dignified running** = a thin indeterminate arc + quiet count in bar tint, no glow.

**From 03 · Glanceable Pro (the information model — strongest overall):**
- **Glance over click.** The bar item itself carries live signal: running **count**
  (tabular mono figures so the bar never reflows) + a **breathing activity
  sparkline/equalizer** (each bar = an active worker) + completion ticker.
- **Sequential completion queue** (also in 01 & 02). Bursts don't flicker: each
  completion pops a green check, holds ~1.3s while a **hairline progress line
  drains**, then the next slides up; a **+N badge** counts those still queued; the
  item settles back to the live view when empty.
- **Dense, keyboard-first popover.** Status glyph · mono name · live elapsed ·
  truncated activity line, sorted running-first; ↑/↓ selection ring, ↵ focuses the
  agent in Eos, esc closes. Every pixel is information.
- **Motion only while working** — ring spins only during work, equalizer stills to
  near-invisibility at idle.

**From 02 · Alive & Expressive (use sparingly — one signature flourish):**
- **The dawn-orb as the running identity.** A breathing orb made of the brand —
  ties directly to the logo's halo/core. Worth borrowing as the running glyph, but
  keep its expressiveness dialed toward 01/03's restraint (its multi-layer glow +
  orbiting particles + sparkle-burst celebration are louder than the app's voice).
- Note: 02 introduces a warm multi-hue "dawn ramp" (`peach/rose/violet/sky`) not
  present in the real app — **do not adopt those hues**; the app's running color is
  `--ok` green and its brand hue is `--accent` `#6ea4e8`. Keep the *dawn metaphor*,
  drop the off-palette colors.

**Recommended merge:** 03's instrument-cluster information model (count + sparkline
+ sequential completion ticker + keyboard popover), built with 01's native
discipline (right-pinned reveal, semantic-color-only, single easing), using the
real Eos tokens above and the dawn-star mark (§5) — borrowing exactly one flourish
from 02 (the breathing orb as the running glyph), recolored to the app palette.
```
