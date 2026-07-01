# Atomic `@`/`/` tokens in the composer — design report

Research-only. Goal: make the blue `@`-file and `/`-slash tokens behave as **atomic
units** for caret traversal (one ArrowLeft/Right step jumps the whole token),
click-selection (a click inside selects/snaps the whole token, never a char
offset), and hover. Deletion is already atomic; selection/caret must match it.

---

## 1. Substrate + root cause (acceptance #1)

### The substrate

A single **`contentEditable` `<div>`** — not a `<textarea>`, not a rich-text
library.

- `app/ui/src/views/code/center/Composer.jsx:974-989` — the editor element:
  `<div ref={editorRef} className="composer-editor" contentEditable role="textbox" …>`.
- `app/ui/src/styles.css:3557` — `-webkit-user-modify: read-write-plaintext-only;`
  (WebKit "plaintext-only" editing mode — no rich blocks, no nested formatting on Enter).
- The editor is a **model-string-is-truth + DOM-is-a-disposable-projection**
  design, all custom-built in `app/ui/src/hooks/useContentEditableEditor.js`:
  - `text` (a plain JS string) is the source of truth (`useContentEditableEditor.js:258`).
  - On every change the DOM is **fully rebuilt** from the model:
    `el.innerHTML = toHtml(text, scanners)` (`useContentEditableEditor.js:288, 325`).
  - `toHtml` → `colorize` wraps matched token ranges in inline
    `<span class="…">` (`useContentEditableEditor.js:215-242`).
  - The model is recovered from the DOM by **linearizing** it back to a string +
    caret offset (`linearize`/`readEditor`, `useContentEditableEditor.js:29-70`).
  - Offsets are the lingua franca: `getCursorOffset`, `getSelectionOffsets`,
    `setSelectionOffsets` convert DOM⇄model positions char-by-char
    (`useContentEditableEditor.js:72-128`).

So the architecture is: **the model owns everything; the contentEditable DOM is a
throwaway render, and (start,end) string offsets are the contract.** This matters
a lot for the recommendation.

### What the blue tokens actually are

`colorize` emits the tokens as **ordinary, editable inline spans** with the literal
token text inside them (`useContentEditableEditor.js:225`):

- `@`-file mentions → `<span class="cmd-hl">@src/foo.ts</span>`
  (scanner: `buildScanners` literalRegions over `insertedPathsRef`,
  `useContentEditableEditor.js:271`; style: `styles.css:3577` `.cmd-hl { color: var(--accent) }` — the blue).
- `/`-slash commands → `<span class="cmd-pill" data-cmd="…">/clear</span>`
  (scanner: `slashRegions`→`findSlashTokens`, `useContentEditableEditor.js:159`;
  style: `styles.css:3579` `.cmd-pill`).
- (Same machinery also produces `[paste]` `paste-pill` and `[attachment]` `att-hl`
  pills, and `{{placeholder}}` `tpl-hl`.)

### Root cause (one sentence)

The tokens are **plain editable `<span>`s whose inner text is the literal token
characters**, so the browser's native caret model sees them as ordinary
characters with no atomic boundary — and nothing in `onKey` intercepts plain
`ArrowLeft`/`ArrowRight` or click to override that, so the caret walks character
offsets straight through a token.

Evidence that arrow/click are *unhandled* for atomicity:
- `Composer.jsx:702-717` handles ArrowUp/Down for **history**, never Left/Right.
- The only ArrowLeft/Right branches (`Composer.jsx:650, 655`) live **inside the
  `showFileMenu` block** (folder descend/ascend); with no menu open they don't run
  and the key falls through to native char-by-char caret movement.
- `onEditorClick` (`Composer.jsx:849-854`) just records `cursorPos =
  getCursorOffset(el)` and maybe opens a pill popover — it never snaps the caret
  off a token interior or selects the token.

A `<textarea>` could never do this at all (no styled sub-ranges); the
contentEditable *can*, because tokens are already real DOM nodes — they're just
not marked atomic.

---

## 2. How atomic-delete already works, and the DRY opportunity (acceptance #2)

Atomic delete is done **entirely in the model**, not via DOM semantics
(`Composer.jsx:736-768`, the `Backspace` branch):

1. Read the caret offset: `pos = getCursorOffset(el)`.
2. Ask "is `pos` inside a token region?" via a family of *find-token-at-offset*
   helpers, each scoped to one token kind:
   - `findPathAt(pos)` — `@`-paths, scans `insertedPathsRef` (`Composer.jsx:398-407`).
   - `findCommandAt(pos)` — `/`-commands, re-scans for `/name` in `cmdMap`
     (`Composer.jsx:296-306`).
   - `findLabelAt(text, pos, …)` — `[paste]` pills (`attachmentTokens.js:35-40`).
   - `attachmentBackspace(pos)` — `[attachment]` labels (in `useAttachmentIntake`,
     uses the same `findLabelAt`).
3. If a region `{start, end}` is hit: splice the whole range out of the model and
   put the caret at `start` — `setTextAndSync(text.slice(0,start)+text.slice(end), start)`
   — plus delete the bookkeeping key (`insertedPathsRef.delete`, `pastesRef.delete`).

The exact same "where are the token regions in the model string" question is
**already answered a second time** for *coloring* — `buildScanners`
(`useContentEditableEditor.js:267-277`) enumerates every token's `{start,end}` to
wrap it in a span. And a **third** time for the sent-message bubble
(`MessageUser.jsx:57` reuses `findSlashTokens`).

**Conclusion for DRY:** there is already a de-facto token model — a set of
`{start, end, kind}` regions over the model string — but it is **computed in three
places by overlapping ad-hoc scans**. Atomic caret + click-select is the *same
question over the same offsets* as atomic delete. It must **reuse/extend that one
region model**, not add a fourth parallel scan. The codebase even states the
intent ("Single source … so the two surfaces can never drift", `slashTokens.js:4-6`)
— we lean into it rather than fight it.

---

## 3. Viable approaches + tradeoffs (acceptance #3)

### Approach A — `contentEditable="false"` atomic islands (browser-native)

Render each token span with `contentEditable="false"` (a "false island" inside a
`true` host). The browser then treats it as a single atomic inline object:

- **Caret:** native ArrowLeft/Right step *over* the island in one move; the caret
  cannot enter it. ✅ for free.
- **Click:** clicking the island places the caret at its boundary (and the island
  selects as a unit on drag). ✅ mostly for free.
- **Delete:** native Backspace removes the whole island. ✅ (but see bookkeeping).
- **Hover:** plain CSS `:hover` (already present for `.cmd-pill`). ✅.

**Complexity / blast radius:** Deceptively large given *this* architecture.
- The model is recovered by **linearizing the DOM every keystroke**
  (`linearize`/`readEditor`). False islands still contain a Text node, so their
  text still contributes to the model string — but the **caret boundary points**
  around islands (caret before the first child island, between two adjacent
  islands with no text node between them, caret at the very end after an island)
  are exactly the positions `linearize`'s `mark(node, childIndex)` and
  `setSelectionOffsets`'s text-length walk would have to be re-audited for.
- WebKit `read-write-plaintext-only` + false islands is a **less-travelled path**;
  classic gotchas: caret can't be placed *before* a leading island or *after* a
  trailing one without a filler/zero-width text node; Firefox historically needs
  zero-width spaces flanking islands to navigate at all. (We're WKWebView-first,
  so WebKit quirks dominate, but the web build also runs in Chromium/Firefox.)
- Native delete removes the DOM node but **won't update the side maps**
  (`insertedPathsRef`, `pastesRef`) — so the explicit Backspace handlers must stay
  anyway, partly defeating the "for free" appeal.

**Risk:** Medium-high. Pushes authority from the model back into fragile native
caret/selection semantics that the whole codebase was deliberately built to *not*
depend on. Bugs here are the notorious "caret vanishes / can't click before the
chip" class.

### Approach B — model-level caret/selection normalizer (JS interception), substrate unchanged

Keep tokens as ordinary spans; intercept the events and reuse the **existing
offset model**:

- **Caret:** in `onKey`, add an `ArrowLeft`/`ArrowRight` branch (when no menu is
  open). Compute `pos`, ask the shared region model "does a token straddle the
  step?", and if so `setSelectionOffsets(el, target, target)` to jump to the far
  boundary in one move; `preventDefault`. (Rules in §5.)
- **Click-select:** in `onEditorClick` (or `mousedown`), after reading `pos`, if
  `pos` is strictly interior to a token region, `setSelectionOffsets(el, start, end)`
  — selects the whole token. Boundary clicks stay a collapsed caret.
- **Hover:** CSS `:hover` per token class (already there for `.cmd-pill`/`.paste-pill`;
  add one rule for `.cmd-hl` `@`-paths).

This is **the same shape as the atomic-delete that already works** — read offset,
hit-test the region model, act on `{start,end}` in the model string.

**Complexity / blast radius:** Small and localized. One shared region/helper
module + ~2 new branches in `onKey` + a few lines in `onEditorClick`. No change to
`linearize`/`setSelectionOffsets`/undo/coloring internals. All logic lives in the
pure-string space the codebase already speaks and unit-tests (`lib/*.test.js`).

**Risk:** Low. The genuine nuances are Shift+Arrow selection extension (needs the
selection's *direction*, see §5 caveats) and double-click word-select interaction.
The browser can still momentarily place a caret inside via some path; we correct
after the fact — acceptable, and identical in spirit to how delete already trusts
the model.

### Approach C — adopt an editor library with native atomic nodes (Lexical / ProseMirror / Slate / Tiptap)

These model atomic inline nodes as first-class (Lexical `DecoratorNode`,
ProseMirror `atom`/leaf node, Slate `void` inline) and give atomic
caret+select+delete out of the box.

**Tradeoff:** This is a **full substrate rewrite**. The custom hook already owns
model linearization, a debounced undo/redo stack
(`undoStack.js`), recolor-on-keystroke, collapsed-paste pills, `{{placeholder}}`
Tab-navigation, markdown list continuation/indent, native-drop + paste intake, and
draft swap across agents — all built around the raw contentEditable + model
string. Replacing the substrate throws away a large body of working, tested code
and re-opens every one of those behaviors. **Not justified** for a feature that an
incremental region-model extension delivers. (Worth it only if the team separately
wants a richer editor; out of scope here.)

---

## 4. Recommendation (acceptance #4)

**Approach B — a shared token-region model + a model-level caret/selection
normalizer — extending the existing atomic-delete model rather than adding a new
substrate or a parallel scan.**

Why, on clean-code / SOLID grounds:

- **DRY / Single Responsibility:** Introduce **one** module that owns "where are
  the atomic tokens in the model text" — returning sorted `{start, end, kind, key}`
  regions. Coloring (`buildScanners`), atomic delete (`findPathAt`/`findCommandAt`/
  `findLabelAt`), the new atomic caret, and click-select all consume *that one
  function*. Three overlapping scans collapse into one source of truth (the
  codebase already wants this — `slashTokens.js:4`).
- **Open/Closed:** Adding a future token kind (e.g. `#`-issues, `:emoji:`) = add
  one scanner entry to the region model. Coloring, caret, delete, and hover then
  treat it atomically **with no edits** to the caret/selection code.
- **Dependency Inversion:** `Composer` (event policy) and the editor hook (DOM
  projection) both depend on the abstract `tokenRegions(text, ctx)` contract, not
  on per-kind string-scanning scattered across files. The normalizer depends on
  `{start,end}` regions, never on the concrete editor or DOM.
- **Liskov:** every token kind is substitutable behind the uniform `{start,end}`
  region contract — the caret/select/delete code is kind-agnostic.
- **Surgical:** keeps the substrate, the linearization, the undo stack, and the
  recolor pipeline untouched. It is the minimum change that makes caret + click
  match the already-atomic delete, and it matches the project's existing layering
  (pure logic in `lib/*`, DOM in `hooks/*`, event policy in `views/*`).

It is also the **lowest-risk** option: it never leans on the flaky
`contentEditable=false` caret edge cases that the whole architecture was built to
avoid. (Approach A is a reasonable *WebKit-only* alternative if the team later
wants the browser to do the work and is willing to own the filler-text-node /
boundary-caret gotchas — but it buys little while the explicit delete handlers must
stay for the side-map bookkeeping.)

Scope note: the directive targets `@` and `/`. The single region model naturally
covers `[paste]`/`[attachment]` pills too (they already use the same delete path),
so they get atomic caret/select "for free." **Exclude `{{placeholder}}` (`tpl-hl`)
from atomicity** — placeholders are *meant* to be selected and typed-over for
replacement (`Tab` navigation, `selectPlaceholder`, `Composer.jsx:308-324`); making
them atomic would break template editing. The region model must carry an
`atomic: true|false` flag per kind so coloring includes placeholders but the caret
normalizer skips them.

---

## 5. Concrete implementation map (acceptance #5)

### New abstraction — one token-region model

New pure module, e.g. `app/ui/src/lib/composerTokens.js` (sits beside
`slashTokens.js`/`attachmentTokens.js`, unit-tested like its neighbors):

```
// ctx = { cmdMap, insertedPaths, pasteKeys, attachmentLabels }
export function tokenRegions(text, ctx) {
  // returns sorted, non-overlapping:
  //   [{ start, end, kind: 'path'|'cmd'|'paste'|'attachment', key, atomic: true }, …]
  // built by delegating to the EXISTING scanners:
  //   findSlashTokens(text, ctx.cmdMap)                  -> kind 'cmd'
  //   literal "@"+display over ctx.insertedPaths         -> kind 'path'
  //   findLabelRegions(text, ctx.pasteKeys)              -> kind 'paste'
  //   findLabelRegions(text, ctx.attachmentLabels)       -> kind 'attachment'
  // (placeholders stay OUT of this list — atomic:false / handled only by coloring)
}

export function tokenAt(regions, pos, { interiorOnly = false } = {}) {
  // interiorOnly:false -> region with start < pos <= end  (delete/left semantics)
  // returns the hit region or null
}

// Caret target when stepping over a token, else null (caller does default move):
export function atomicCaretTarget(regions, pos, dir) {
  if (dir === 'right') { const r = regions.find(r => r.start <= pos && pos < r.end); return r ? r.end : null; }
  if (dir === 'left')  { const r = regions.find(r => r.start < pos && pos <= r.end); return r ? r.start : null; }
}
```

### Files / functions to touch

1. **`app/ui/src/lib/composerTokens.js` (new)** — the region model + helpers above.
   Pure, fully unit-testable (mirror `slashTokens.test.js`).

2. **`app/ui/src/hooks/useContentEditableEditor.js`** — refactor `buildScanners`
   (`:267-277`) to derive its color regions from `tokenRegions(...)` (map `kind`→`cls`/`attrs`),
   so coloring and caret share one source. (Optional but this is the DRY payoff;
   can be staged — the new caret code can consume `tokenRegions` first, coloring
   migrated after.)

3. **`app/ui/src/views/code/center/Composer.jsx`**
   - Build `regions = tokenRegions(text, ctx)` once (memoized on
     `[text, cmdMap, insertedPaths, pasteKeys, attachmentLabels]`).
   - **`onKey` (`:588`)** — add, *after* the menu/history guards and *before*
     falling through, a plain Arrow branch:
     ```
     if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !showMenu && !showFileMenu && !e.altKey) {
       const pos = getCursorOffset(el);
       const target = atomicCaretTarget(regions, pos, e.key === 'ArrowLeft' ? 'left' : 'right');
       if (target != null) {
         e.preventDefault();
         if (e.shiftKey) extendSelectionTo(el, target);   // see caveat
         else setSelectionOffsets(el, target, target);
         setCursorPos(target);
         return;
       }
     }
     ```
   - **`onEditorClick` (`:849`)** — after `setCursorPos(getCursorOffset(el))`, snap:
     ```
     const hit = tokenAt(regions, getCursorOffset(el), { interiorOnly: true });
     if (hit) { setSelectionOffsets(el, hit.start, hit.end); setCursorPos(hit.end); }
     ```
     (Consider doing this on **`mousedown`** with `preventDefault` to avoid a
     one-frame flicker of the native interior caret; `onClick` after-the-fact is
     simpler and matches the existing handler — pick one, note the tradeoff.)
   - **DRY cleanup:** `findPathAt`/`findCommandAt` and the `findLabelAt` calls in
     the Backspace branch can be reduced to `tokenAt(regions, pos)` (kind-dispatch
     the side-map delete). This unifies delete with the new caret/click on the same
     model — the core SOLID win.

4. **`app/ui/src/styles.css`** — add a hover rule for `@`-paths to match the pills:
   `.composer-editor .cmd-hl:hover { background: color-mix(in srgb, var(--accent) 24%, transparent); border-radius: 5px; }`
   (`.cmd-pill`/`.paste-pill` hover already exist at `:3587`/`:3608`).

### Event handlers involved

| Behavior            | Handler / location                          | Action |
|---------------------|---------------------------------------------|--------|
| Atomic caret L/R    | `keydown` → `onKey` (`Composer.jsx:588`)    | jump to token boundary, `preventDefault` |
| Click selects token | `click`/`mousedown` → `onEditorClick` (`:849`) | `setSelectionOffsets(start,end)` on interior hit |
| Hover highlight     | CSS `:hover` (no JS) + existing pointer delegation (`:856-880`) for the info popover | visual only |
| Atomic delete       | `keydown` Backspace (`:736-768`) — already works | refactor to shared `tokenAt` |

### Cross-browser / Selection-API caveats to watch

- **Shift+Arrow selection extension** needs the selection's *direction* (which end
  is the focus). `getSelectionOffsets` returns `{start,end}` only — not anchor vs
  focus. To extend correctly, read `window.getSelection().focusNode/focusOffset`
  (linearize that point) and move only the focus to the token boundary, or use
  `selection.modify('extend', dir, 'character')`-style logic guarded by the region
  model. Flag this as the one non-trivial piece.
- **Double-click word-select** over a token: native double-click selects a "word"
  which may be a sub-span of the token (`@src`, then `/foo`). If exact-token
  selection is desired on double-click, intercept `dblclick` and
  `setSelectionOffsets(start,end)`; otherwise leave native behavior (acceptance only
  requires single-click).
- **`setSelectionOffsets` end-of-text quirk** (`useContentEditableEditor.js:115-124`):
  a trailing `\n` is projected as a filler `<br>`, so an offset at the very end
  clamps onto the empty final line. A token at end-of-text is fine (its text node
  exists), but verify caret-after-last-token lands correctly.
- **Recolor reentrancy:** `applyColoring` rebuilds `innerHTML` and restores the
  caret via `setCursorOffset` whenever `text` changes (`:279-297`). Our caret jump
  changes only the *selection*, not `text`, so it won't trigger a recolor — but if
  click-select is wired through any path that sets text, guard against the
  `suppressInputRef` round-trip.
- **`getSelectionOffsets` vs collapsed caret:** the hit-test must use the live DOM
  offset (`getCursorOffset`) at event time, not the React `cursorPos` state, which
  lags (updated on `keyup`/`click`, `Composer.jsx:851, 988`).

---

## 6. Browser-native primitives that help (acceptance #6)

- **`contentEditable="false"` islands** inside a `contentEditable="true"` host *do*
  make a node atomic for caret, selection, and delete automatically (this is
  Approach A). The current substrate **can** technically use them — the spans are
  already real DOM nodes; flipping `contentEditable="false"` on the token spans in
  `colorize` (`useContentEditableEditor.js:225`) is mechanically small. **But** the
  surrounding machinery (every-keystroke `linearize` of the DOM back to the model,
  `read-write-plaintext-only` mode, the boundary-caret/filler-text-node edge cases,
  and the still-required side-map delete handlers) means it does **not** drop in
  cleanly and trades model-owned determinism for native-selection fragility. Noted
  as a viable WebKit-first alternative, **not recommended** as the primary path.
- **`Selection.modify('move'|'extend', 'forward'|'backward', 'character')`** is a
  native helper that can simplify Shift+Arrow extension once we've decided the
  target boundary — usable in WebKit/Chromium (Firefox support is partial; guard).
- **CSS `:hover`** is the only primitive needed for hover highlight — no JS. The
  existing `.cmd-pill:hover`/`.paste-pill:hover` rules (`styles.css:3587, 3608`)
  are the precedent; just add the `@`-path (`.cmd-hl`) rule.
- **`user-select`/`::selection`** can style the whole-token selection so a
  click-selected token reads as one chip rather than a text highlight (polish, optional).

---

## Bottom line

Substrate is a custom **contentEditable + model-string projection**; the root cause
is that tokens are **plain editable spans with no atomic boundary** and no
arrow/click interception. The atomic-delete already proves the right pattern —
**hit-test token regions in the model string** — so the fix is to **lift the token
regions into one shared model and reuse it for caret + click-select + hover**
(Approach B), not to bolt on `contentEditable=false` islands (Approach A) or swap in
an editor library (Approach C). This is the surgical, DRY, SOLID extension of what
already works.
