# Designing an Eos plugin

Read this before writing any plugin the user will see. It sets the bar and the process; it gives no ready-made design on purpose. Every plugin gets its own design, made for what it does.

## The bar

The plugin should look like a team of good product designers made it for Eos: it belongs in the app, and at the same time it has a clear point of view of its own. Someone opening it should feel it was considered — the hierarchy reads at a glance, the main action is obvious, it responds to every touch with motion that explains what happened, and the small details (empty state, counts, shortcuts, timestamps, focus, hover) are all there.

"It works and it's tidy" is not the bar. A plugin that is merely clean, uses default-looking controls, or puts everything at one size and one weight has failed, even if every feature works.

## Two layers: the frame and the content

- **The frame belongs to Eos.** Header row, the surface background, chrome controls (search fields, header buttons, chips), borders, radii and system text follow Eos's tokens, so the plugin sits in the app without a seam.
- **The content has character.** The plugin's own subject — the objects the user creates, the numbers they watch, the canvas they work on — may have its own palette, larger and more expressive type, depth, texture and motion. This is where the design shows. Make the content the hero; keep the frame quiet.

Decide which parts are frame and which are content in your brief.

## Step 1 — the design brief

Before writing code, write a short brief (a few lines in your reply or your own notes) covering:

1. **The job.** What the user comes here to do, and the one action that must take under a second (often: get something in, or glance at something).
2. **The signature moment.** One thing that will make the user smile or remember it — a tactile interaction, a satisfying transition, a clever use of color, a detail that anticipates them. Every plugin gets one; design it deliberately.
3. **Layout and hierarchy.** What the eye hits first, second, third. Where the main action lives. How it behaves narrow and wide.
4. **Visual direction.** In a few words: mood, density, palette idea (and how it works on Eos's dark background), type scale for the content, the material (flat, soft depth, glass, paper, …).
5. **States.** First run (empty), one item, a typical amount, a lot, long text, a search with no match, anything that can fail or be in progress.
6. **Interactions.** Keyboard shortcuts, hover/press/focus, inline editing, undo for anything destructive, what saves and how the user knows it saved.
7. **Motion plan.** What animates on first paint, on add, on remove, on reorder/filter, on hover/press, and on open/close.
8. **Data.** The `useStore` keys and the shape of their values — this is also what you'll feed `plugin_preview`.

Then build to the brief, and review against it.

## Eos's material

Eos is dark-only. Use these tokens for the frame and as the base for everything else.

- **Surfaces:** `--bg` (window), `--panel` (sidebar, side panel), `--raised` (cards, inputs), `--row-on` (hover/selected fill), `--chip` (pills, small buttons), `--pop` (popovers, menus). Lines: `--line` (the only border color; use borders sparingly).
- **Text:** `--fg-strong` (titles), `--fg` (body), `--fg-mid` (secondary), `--fg-dim`, `--fg-dim2` (icons, placeholders), `--fg-faint` (meta, labels), `--fg-mute` (disabled).
- **Accents:** `--accent` (text on it: `--accent-fg`), `--ok`, `--warn`, `--err`, `--amber`, `--violet`. Soft fills: `color-mix(in srgb, var(--accent) 14%, transparent)`.
- **Solid button:** `--solid-btn-bg`, `--solid-btn-fg`, `--solid-btn-bg-hover` — Eos's high-emphasis button.
- **Glass chips:** background `--lg-chip-bg`, shadow `--lg-chip-sh`; active/hover `--lg-chip-on-bg`, `--lg-chip-on-sh`. For floating controls and toggles in the frame.
- **Type:** `--font-ui` (Geist), `--font-mono` (IBM Plex Mono). Sizes `--text-xs` 12, `--text-sm` 13, `--text-base` 14, `--text-md` 15, `--text-lg` 16, `--text-xl` 17, `--text-2xl` 19, `--text-3xl` 22 px.
- **Radius:** `--r-row` 8 (buttons, rows), `--r-card` 10, `--r-pop` 14, `--r-modal` 16, `--r-pill`.
- **Shadows:** `--sh-pop`, `--sh-modal` for floating layers.

Never hard-code grays for the frame; derive from these. Content colors are yours (see Color).

## Layout and hierarchy

- **One focal point.** Decide what the eye lands on first and make it unmistakably first through size, weight, color or space — not all four at once.
- **Spacing scale.** Use one rhythm (multiples of 4: 4, 8, 12, 16, 24, 32, 48). Related things sit close; groups are separated by clearly more space than items within them. Generous outer padding (24–32 px on a main view) — nothing touches the edges.
- **A page intro when it helps.** A main view may open its body with a title in a display size, a one-line subtitle that says what the place is for, and live meta (a count, a status) aligned with it.
- **Alignment.** Everything sits on a few shared edges. Text baselines line up across columns. Mixed alignments look accidental.
- **Readable widths.** Long text columns stay under ~70 characters; grids reflow with the window instead of stretching items.
- **Responsive.** Check narrow (a split pane, ~600 px) and wide (~1400 px). The side panel is ~420 px — design panel tabs for that width first.

## Typography

- Build a clear scale with real contrast: a display size for the content's hero text (often 18–28 px, can go larger for a single number or headline), a body size, and a small meta size. Don't let everything sit at 13–14 px.
- Use weight with intent: 400 for reading, 500–600 for emphasis and titles. Two or three weights at most.
- Small uppercase labels with letter-spacing (about 0.06–0.1em, 11–12 px, `--fg-faint`) separate categories without shouting.
- Tight line-height (1.15–1.3) for display text, relaxed (1.5–1.6) for reading.
- `font-variant-numeric: tabular-nums` for any number that changes (timers, counts).
- Nothing below 12 px. Truncate with an ellipsis or clamp lines instead of letting text break the layout.
- Content may use a character face from the system stacks (`ui-serif`, `ui-rounded`, `ui-monospace`) when it fits the direction — never a downloaded font.

## Color

- **Frame:** Eos tokens only.
- **Content palette:** design one for the plugin's subject and mood — a small, harmonious set (often 4–7 hues of matched lightness and saturation), not random picks. Test it on `--bg`.
- **On a dark background, choose one approach per plugin:**
  - *Luminous objects:* light, softly saturated surfaces with dark ink on them (text ≈ near-black at 80–90% opacity), plus a real shadow so they sit above the dark; or
  - *Tinted dark:* surfaces that mix a hue at roughly 12–24% into `--raised`, with light text and the hue at full strength only on small accents (a dot, a label, an edge).
  Mixing the two approaches in one plugin looks unplanned.
- Text contrast at least 4.5:1 for body, 3:1 for large text. Check meta text on colored surfaces especially.
- Let color carry meaning (category, status, selection), not decoration. One accent leads; the rest support.
- Interactive states must be visible in color as well as shape: hover, selected, focused, disabled.

## Depth and material

- Prefer soft, layered shadows (a wide ambient shadow plus a tight contact shadow) over borders to lift objects. Large objects get larger, softer shadows.
- A 1 px inner highlight on the top edge (an inset shadow in a light tint) makes surfaces feel crafted rather than flat.
- Use the glass chip tokens for floating frame controls. Keep heavy blur to small floating layers.
- Subtle texture (a faint gradient, a tiny noise via an SVG data URL, a gentle tilt) can give content a physical feel — when it serves the direction, and never at the cost of readability.

## Motion

Motion is part of the design, not decoration added at the end. Every change of state should be animated so the user sees what happened and where things went.

**Timing.**
- Micro feedback (hover, press, toggles): 120–160 ms.
- Standard transitions (expand, filter, tab switch): 200–260 ms.
- Entrances and larger moves: 280–450 ms.
- Exits are faster than entrances (about 2/3 of the time).
- Stagger groups by 30–50 ms per item and cap the total (only the first ~8 items stagger).

**Easing.** Use Eos's curves so the plugin moves like the app:
- Entering / settling: `cubic-bezier(0.16, 1, 0.3, 1)`.
- Standard state changes: `cubic-bezier(0.2, 0.7, 0.3, 1)`.
- Moving between two places on screen: `cubic-bezier(0.32, 0.72, 0, 1)`.
- A small overshoot (a spring) only for playful, tactile moments — a curve like `cubic-bezier(0.34, 1.56, 0.64, 1)`, used once or twice, never on everything.
- Never `linear` except for continuous progress.

**What to animate.** Only `transform` and `opacity` (and `filter` sparingly). Never animate `width`, `height`, `top`/`left` or `margin` frame by frame; for size changes animate `grid-template-rows` between `0fr` and `1fr`, or scale and then settle.

**Patterns to cover:**
- *First paint:* content fades in with a small upward move (6–12 px) and a slight scale (0.98 → 1), staggered.
- *Add:* the new thing appears from where it was created (the input, the button) or grows into its slot, and surrounding items make room smoothly.
- *Remove:* fade and shrink slightly, then let the gap close smoothly; offer undo for a few seconds.
- *Reorder, filter, sort:* items glide to their new places. Use the FLIP technique: record each item's position before the change, apply the change, measure again, set a transform that puts each item back where it was, then transition the transform to none. Items leaving and entering use the add/remove motions.
- *Hover:* lift slightly (−1 to −3 px) with the shadow growing; *press:* scale to about 0.97–0.98.
- *Open/close* (menus, editors, details): grow from their trigger (`transform-origin` at the trigger).
- *Numbers:* changing values keep their width (tabular numbers) and can roll or crossfade.
- *Saved / done:* a brief, quiet confirmation (a check that draws in, a dot that pulses once) instead of a blocking message.

**Respect the user.** Under `@media (prefers-reduced-motion: reduce)`, keep opacity fades and drop movement and scaling. Nothing animates forever except real progress. Motion never delays input: the UI responds on the first frame and animates on top.

## Interaction and usability

- **The main action is fast.** If the plugin captures something, the input is ready (focused when the view opens), Enter or ⌘/Ctrl+Enter commits, Esc clears or cancels, and the result appears immediately. Show the shortcut subtly next to the action.
- **Direct manipulation.** Edit things in place; avoid modal dialogs for simple edits.
- **Autosave with feedback.** Everything saves on its own; show that it did, quietly.
- **Undo over confirm.** Destructive actions happen at once with an undo; confirmation dialogs only for irreversible bulk actions.
- **Search and filters** filter live, show a count, highlight matches, and have a clear way back (Esc, an × in the field). A "no matches" state says what was searched.
- **Empty states teach.** First run gets an inviting state: a drawn glyph or illustration in the plugin's style, one line saying what this place is for, and the action to start. It's a designed moment, not a stray line of gray text.
- **Time and meta.** Relative times ("just now", "5 min ago", then dates), counts, and status read naturally and update.
- **Controls you build look intentional.** Text fields have a visible but soft field shape, a placeholder that reads as a hint (not as the only label when the meaning isn't obvious), and a clear focus ring (2 px, accent, softened with color-mix). Hide native resize grips and default control chrome; style selects, checkboxes and range inputs or build your own.
- **Buttons have a hierarchy:** one primary (solid), secondary (glass chip), tertiary (text or icon only). Icon-only buttons get a `title` and `aria-label`.
- **Icons:** one consistent set you draw as inline SVG — same stroke width (about 1.4–1.6), rounded caps and joins, `currentColor`, 14–16 px in the frame. Never emoji as icons.
- **Accessible:** keyboard reaches every action in a sensible order, focus is always visible, hit targets are at least 28 px, color is never the only signal.

## Things that make a plugin look cheap

Avoid every one of these:

- A plain textarea or input with the native look or resize grip; default selects, checkboxes or range sliders.
- Everything at one text size and weight; no clear first thing to look at.
- Content crammed against edges, or uneven gaps.
- Borders around everything instead of space and depth.
- Random hard-coded grays in the frame; a content palette whose colors don't belong together.
- Things that appear, disappear or jump with no motion.
- An empty state that is one line of faint text.
- Emoji used as icons; mismatched icon styles.
- More than one competing accent; neon or generic gradient clichés.
- Text that is hard to read on colored surfaces.
- Buttons that all look the same, or a primary action that's hard to find.
- Lorem ipsum or "Test" in previews — preview with real-sounding content.

## Step 2 — review with `plugin_preview`

Preview at least:

1. **Typical:** 5–8 realistic items with real-sounding, varied content (short and long).
2. **Empty:** the first-run state (pass empty values for your keys).
3. **Stress:** long text, many items (30+), and a narrow width (`width` ≈ 600 for a main view).
4. Every other surface the plugin registered (`available` lists them).

For each picture, ask honestly:

- Does the eye land on the right thing first? Squint: does the hierarchy still read?
- Is spacing even and rhythmic, edges aligned, nothing touching the sides?
- Is every text readable on its background?
- Does the frame look like Eos, and does the content have its own character?
- Is the signature moment from the brief visible and good?
- Does anything look default, unfinished or cheap (see the list above)?
- Would a demanding designer ship it? If not, what would they change first?

Fix the most important problem, preview again, and repeat. Motion doesn't show in a still: before finishing, read your CSS and components against the motion patterns above and make sure every add, remove, filter, hover, press and open/close is covered, with reduced-motion handled.
