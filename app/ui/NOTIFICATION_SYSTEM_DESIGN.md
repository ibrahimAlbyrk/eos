# Toast / Notification System — Design

Reusable, decoupled toast notifications for the Eos web UI (React 18 + Vite,
`app/ui/`). Top-right, slide-in-from-right, ~3s auto-dismiss, slide-out-to-right,
pointer-drag-right to dismiss early. Three severities — `info` / `warning` /
`error` — callable from **any** subsystem.

This is a design document. Snippets are illustrative, not the final code.

---

## 0. Grounding — the conventions this design matches

Everything below is anchored to patterns already in the tree, not invented:

| Concern | Existing pattern used as the template | Where |
| --- | --- | --- |
| Ephemeral shared state | Module-singleton store (`subscribe`/`getX`/`emit`) | `src/state/ptyPanelStore.js`, `src/state/archiveStore.js`, `src/state/inputNeededStore.js` |
| Reactive read | `useSyncExternalStore(subscribe, getSnapshot)` in a thin hook | `src/hooks/useInputNeeded.js`, `src/state/explorerStore.js:392` |
| App-wide overlay mount | Sibling in `Shell`, inside `UiProvider` | `src/App.jsx:49-58` (`CommandPalette`, `MonitorWidget`, `SettingsModal`) |
| Escaping the layout to top layer | `createPortal(node, document.body)` | `src/views/code/ImageLightbox.jsx:138`, `src/views/code/center/PushButton.jsx:188` |
| Pointer drag | `setPointerCapture(e.pointerId)` + move/up/cancel | `src/views/code/popovers/EffortPopover.jsx:96-112`, `src/views/code/panes/PaneGrid.jsx:275` |
| Animate-then-unmount + reduced-motion fallback | WAAPI exit, `drop()` after `finished`, no-`animate` guard | `src/hooks/usePaneTransitions.js` |
| Glass surface | `.glass-pop` (blur + rim `::after` mask) | `src/styles.css:4484` |
| Severity colors | `--err` / `--warn` / `--accent` / `--ok` (light + dark) | `src/styles.css:107-116, 176-183` |
| House easing | `cubic-bezier(0.2, 0.7, 0.3, 1)` (12 uses) | `src/styles.css` |
| Reduced-motion | `@media (prefers-reduced-motion: reduce)` blocks + `matchMedia` JS guard | `src/styles.css:370`, `src/hooks/usePaneTransitions.js:4` |

There is **no** existing toast/snackbar system today (`grep -riE 'toast|snackbar'`
over `src` returns nothing). The "Notifications" settings group
(`src/settings/registry.jsx:83`) only governs sidebar attention dots — unrelated.

---

## 1. Architecture survey and recommendation

### Approach A — Store-backed imperative API  ✅ RECOMMENDED

A module-singleton store holds the live toast list; three plain functions
(`notify.info/.warning/.error`) mutate it; one `<ToastViewport>` subscribes and
renders. Producers import the functions, not the store internals.

- **Why it fits.** This is the exact shape of `ptyPanelStore.js` /
  `archiveStore.js` / `inputNeededStore.js`: a `Set` of subscribers, an `emit()`,
  a stable snapshot for `useSyncExternalStore`, mutators callable from anywhere.
  The header comment of `ptyPanelStore.js:1-9` states the reason Eos prefers a
  singleton — the producers and the renderer live in **different subtrees**
  (and survive StrictMode / remounts). Toasts have the same property in the
  extreme: producers are scattered across the whole app; the renderer is one
  node in `Shell`.
- **Decoupling win.** Because the API is module functions (not a hook), it is
  callable from **non-React** code too — `src/api/client.js`, an SSE handler, a
  store's catch block — exactly like `openTab()` (`ptyPanelStore.js:35`) and
  `setInputNeeded()` (`inputNeededStore.js:14`) already are. A hook-only API
  cannot do this.

### Approach B — Context Provider + `useToast()` hook

A `<ToastProvider>` wraps the app; components call `const toast = useToast()`.

- **Rejected.** Three problems. (1) The call site must be a React component that
  has run the hook — you cannot fire a toast from `api/client.js`, a store, or
  an event handler outside the tree, which defeats "her sistem her yerde
  kullanabilsin" (usable everywhere). (2) It is a **foreign** pattern: Eos has no
  app-wide context except `UiProvider`; the codebase deliberately uses
  singletons for cross-subtree state (`ptyPanelStore.js:1-5`). (3) No benefit in
  return — toasts need no per-subtree scoping.

### Approach C — Event bus (emitter)

A pub/sub emitter (à la `src/state/ptyBus.js`) that components fire events into,
with a listener that owns the list.

- **Rejected as primary — it collapses into Approach A.** You still need a store
  to hold the live list, per-toast timers, and the render snapshot. The bus
  becomes a redundant front door to the store's mutators, which already *are* the
  "emit" surface. `ptyBus.js` exists for a different reason (fan-out of raw PTY
  bytes to many terminals); a toast has a single renderer, so a bus adds an
  indirection with no payoff.

**Recommendation: Approach A.** It is the house pattern, it is the only option
that stays callable from non-React code, and it introduces zero new concepts.

---

## 2. Public API surface (SOLID)

A single facade module exports the abstraction every producer depends on:

```js
// src/lib/notify.js — the ONLY thing producers import.
import { push, dismiss, clear } from "../state/toastStore.js";

export const notify = {
  info:    (message, opts) => push({ severity: "info",    message, ...opts }),
  warning: (message, opts) => push({ severity: "warning", message, ...opts }),
  error:   (message, opts) => push({ severity: "error",   message, ...opts }),
  dismiss, // (id) => void
  clear,   // () => void
};
```

Call sites, from anywhere (React or not):

```js
import { notify } from "../lib/notify.js";

notify.info("Worker spawned");
notify.warning("Branch has conflicts");
const id = notify.error("Push failed", { title: "Git", duration: 6000 });
notify.dismiss(id); // early, programmatic
```

`opts` (all optional): `{ title, duration, dismissible }`.
`push` returns the new toast `id` so a caller can dismiss/replace it later.

**SOLID mapping:**

- **SRP.** `toastStore.js` owns *list + lifecycle*; `Toast.jsx` owns *one toast's*
  timer/drag/exit; `ToastViewport.jsx` owns *placement + a11y region*; severity
  presentation is *data* (a lookup map), not branching. Each has one reason to
  change.
- **OCP.** Adding a severity = add a token + one line to a `SEVERITY` map + one
  wrapper on `notify`. The store core (`push`) never changes — it treats
  `severity` as an opaque string. Open for extension, closed for modification.
- **LSP.** All three severities produce the same toast shape and flow through the
  same `push`; they are interchangeable everywhere a toast is expected.
- **ISP.** Producers import only `notify` (3 verbs). The viewport imports only
  `useToasts` + `dismiss`. Nobody is forced to depend on the store's full
  surface.
- **DIP.** Components depend on the `notify` abstraction (a stable set of
  functions), never on the store module or React context. The store is the
  low-level detail behind that seam — swappable without touching a single call
  site.

---

## 3. Module / file breakdown

```
src/state/toastStore.js          NEW  singleton: push/dismiss/clear/beginExit + subscribe/getToasts/_reset
src/state/toastStore.test.js     NEW  mirrors ptyPanelStore.test.js (snapshot stability, cap, dismiss)
src/lib/notify.js                NEW  imperative facade (the abstraction producers import)
src/hooks/useToasts.js           NEW  useSyncExternalStore(subscribe, getToasts)
src/components/toast/Toast.jsx        NEW  one toast: auto-dismiss timer, drag, exit, aria
src/components/toast/ToastViewport.jsx NEW  fixed top-right region (portal), maps toasts → <Toast>
src/App.jsx                      EDIT mount <ToastViewport/> as a Shell sibling
src/styles.css                   EDIT append a "TOASTS" section (viewport, card, keyframes, reduced-motion)
```

### Store shape

```js
// src/state/toastStore.js  (shape only — mirrors ptyPanelStore.js)
let toasts = [];                 // [{ id, severity, message, title, duration, leaving }]
let snapshot = toasts;           // stable ref between emits (useSyncExternalStore contract)
const subs = new Set();
let seq = 0;                     // monotonic id source — deterministic, test-stable
const MAX = 4;                   // hard cap (see §5 Queue limits)
const DEFAULT_MS = 3000;

function emit() { snapshot = toasts; for (const cb of subs) cb(); }

export function subscribe(cb) { subs.add(cb); return () => subs.delete(cb); }
export function getToasts() { return snapshot; }   // never rebuilt unless mutated

export function push({ severity = "info", message, title, duration = DEFAULT_MS, dismissible = true }) {
  const id = ++seq;
  let next = [...toasts, { id, severity, message, title, duration, dismissible, leaving: false }];
  if (next.length > MAX) next = next.slice(next.length - MAX); // evict oldest
  toasts = next; emit();
  return id;
}

export function beginExit(id) { // flip to leaving so the viewport plays slide-out
  toasts = toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t)); emit();
}
export function dismiss(id) { toasts = toasts.filter((t) => t.id !== id); emit(); }
export function clear() { toasts = []; emit(); }
export function _resetToasts() { toasts = []; snapshot = toasts; subs.clear(); seq = 0; }
```

Notes: `id` comes from a module counter — not `Date.now()`/`Math.random()` —
matching the "store never invents randomness" spirit of `ptyPanelStore.js` and
keeping tests deterministic. `getToasts()` returns the same array reference until
a mutation rebuilds it — the `useSyncExternalStore` no-tearing contract that
`ptyPanelStore.test.js:135` asserts. Add the same assertion for this store.

### Data flow

```
notify.error(msg)                       (any module, anywhere)
      │
      ▼
push()  →  toasts=[...], emit()          (toastStore singleton)
      │
      ▼
useToasts()  re-renders  ToastViewport   (useSyncExternalStore)
      │
      ▼
<Toast> mounts  →  CSS `toast-in` slide-in on mount
      │
      ├─ setTimeout(duration) ──► beginExit(id)  ──► `.leaving` slide-out ──► transitionend ──► dismiss(id)
      ├─ hover / drag ──────────► pause (clear) timer;  leave ──► resume
      └─ pointer drag past threshold on release ──► exit + dismiss(id)
```

### Mount point

Add one sibling in `Shell` next to the other app-wide overlays
(`src/App.jsx:49-58`):

```jsx
<ActiveView live={live} />
<NativeToggleZone popup={popup} hasAttention={hasAttention} />
<SideHandle popup={popup} hasAttention={hasAttention} />
<CommandPalette live={live} />
<MonitorWidget live={live} />
<SettingsModal />
<ToastViewport />         {/* ← new */}
```

`ToastViewport` renders through `createPortal(…, document.body)` (like
`ImageLightbox.jsx:138` / `PushButton.jsx:188`) so it sits in the top layer above
every panel and modal, unaffected by any parent `overflow`/`transform`.

---

## 4. UX mechanics (implementer-level detail)

### 4.1 Slide-in-from-right (on mount)

New toast enters from the right edge, moving left. Pure CSS `@keyframes` on
mount — no JS needed for the entrance.

```css
@keyframes toast-in {
  from { opacity: 0; transform: translateX(24px); }
  to   { opacity: 1; transform: translateX(0); }
}
.toast { animation: toast-in 220ms cubic-bezier(0.2, 0.7, 0.3, 1) both; }
```

`cubic-bezier(0.2, 0.7, 0.3, 1)` is the codebase's dominant enter/exit curve
(12 occurrences, e.g. `usePaneTransitions.js:56`), so the motion reads as
in-house. `translateX(24px)` (not `100%`) gives a snappy nudge; use `100%` +
larger offset if a full off-screen glide is preferred.

### 4.2 Auto-dismiss timer (~3s) + hover/drag pause

The timer lives inside `Toast.jsx` (SRP: each toast owns its own clock), kept in
a `ref` so hover can pause it. Recommended: true pause/resume that preserves
remaining time.

```js
// inside Toast.jsx (illustrative)
const remainingRef = useRef(duration);
const startedRef = useRef(0);
const timerRef = useRef(null);

const startTimer = () => {
  startedRef.current = performance.now();
  timerRef.current = setTimeout(() => beginExit(id), remainingRef.current);
};
const pauseTimer = () => {
  clearTimeout(timerRef.current);
  remainingRef.current -= performance.now() - startedRef.current; // keep the leftover
};

useEffect(() => { startTimer(); return () => clearTimeout(timerRef.current); }, []);
```

- **Hover** → `onMouseEnter=pauseTimer`, `onMouseLeave=startTimer`. Standard
  toast affordance so a user can read/act before it self-dismisses.
- **Drag** also pauses (calls `pauseTimer` on pointerdown) and resumes on a
  below-threshold release.
- Simpler fallback if pause/resume is overkill: on hover `clearTimeout`, on leave
  restart the full `duration`. Recommend the leftover-preserving version above —
  it is only a few lines more and feels correct.

### 4.3 Pointer-drag-right to dismiss

Uses the established `setPointerCapture` idiom (`EffortPopover.jsx:96-112`).
Rightward-only, matching the operator's "drag it to the right."

```js
// inside Toast.jsx (illustrative)
const THRESHOLD = 80;            // px; or 0.35 * cardWidth
const [dx, setDx] = useState(0);
const draggingRef = useRef(false);
const startXRef = useRef(0);

const onPointerDown = (e) => {
  e.currentTarget.setPointerCapture(e.pointerId);
  draggingRef.current = true; startXRef.current = e.clientX; pauseTimer();
};
const onPointerMove = (e) => {
  if (!draggingRef.current) return;
  setDx(Math.max(0, e.clientX - startXRef.current));   // clamp: right only
};
const onPointerUp = () => {
  draggingRef.current = false;
  if (dx > THRESHOLD) beginExit(id);   // fling → exit (slide-out continues right)
  else { setDx(0); startTimer(); }     // snap back (CSS transition) + resume
};
```

Mapping drag → transform/opacity, with the transition disabled *only while
dragging* so the finger tracks 1:1 (like `.ep-slider.dragging`,
`EffortPopover.jsx:160`):

```jsx
<div
  className={"toast toast--" + severity + (draggingRef.current ? " dragging" : "") + (leaving ? " leaving" : "")}
  style={dx ? { transform: `translateX(${dx}px)`, opacity: Math.max(0, 1 - dx / 160) } : undefined}
  onPointerDown={onPointerDown}
  onPointerMove={onPointerMove}
  onPointerUp={onPointerUp}
  onPointerCancel={onPointerUp}
>
```

```css
.toast { transition: transform 220ms cubic-bezier(0.2,0.7,0.3,1), opacity 220ms; }
.toast.dragging { transition: none; }            /* 1:1 finger tracking */
.toast.leaving { transform: translateX(120%); opacity: 0; } /* slide-out-to-right */
```

### 4.4 Slide-out-to-right (auto or fling)

Both the 3s timeout and an above-threshold drag call `beginExit(id)`, which flips
`leaving:true`. The `.leaving` rule transitions the card off to the right; on
`transitionend` the toast calls `dismiss(id)` to leave the store and unmount:

```js
onTransitionEnd={(e) => { if (leaving && e.propertyName === "transform") dismiss(id); }}
```

**Critical reduced-motion guard:** when the transition is disabled (§5), the
`transitionend` event never fires, so the toast would never unmount. Mirror the
fallback in `usePaneTransitions.js:53` — if reduced-motion (or no transition
support), skip the animation and `dismiss(id)` immediately (or via a short
`setTimeout` fallback that races `transitionend`).

---

## 5. Edge cases

- **Stacking.** Viewport is a `position: fixed` flex column, top-right, `gap`
  between cards; newest appended (renders lowest, closest to nothing) or
  prepended (newest on top) — recommend **newest on top**. Each toast owns an
  independent timer, so they expire out of order without interfering. Removal of
  a middle toast: siblings reflow; a `transition` on the column's layout (or a
  height/margin collapse on `.leaving`) avoids a jarring jump — optional polish,
  a FLIP pass is *not* required for v1.
- **Timer pause on hover / drag.** §4.2 — pointer over the viewport (or an
  individual card) pauses; leaving resumes with the leftover time. Also pause
  while dragging.
- **Queue limits.** Toasts can be fired by machines (an SSE error storm, a loop),
  not just user clicks — unlike `ptyPanelStore` whose tabs are user-bounded. So a
  hard cap matters: `MAX = 4` visible; `push` evicts the oldest
  (`next.slice(-MAX)`). Option: instead of evicting, buffer overflow in a pending
  queue and promote as slots free — recommend the simpler **evict-oldest** for
  v1 and note the queue as a future extension (OCP: only `push` changes).
- **Duplicate suppression (optional).** If the same `severity+message` is pushed
  while still live, refresh its timer instead of stacking a duplicate. Note as an
  opt-in extension, off by default.
- **Accessibility (`aria-live`).** The viewport is a live region so screen
  readers announce toasts without focus moving:
  - Container: `role="region"` `aria-label="Notifications"`.
  - `info`/`warning` cards: `role="status"` in an `aria-live="polite"` sub-region.
  - `error` cards: `role="alert"` (`aria-live="assertive"`) — interrupts, since
    errors are consequential. Practical implementation: two stacked live regions
    (one polite, one assertive) and route each toast by severity, because
    `aria-live` must be set on a container that exists *before* content is
    inserted.
  - `aria-atomic="true"` per card so the whole message is read, not a diff.
  - Provide a keyboard-reachable close button (`aria-label="Dismiss"`); the drag
    gesture is mouse/touch only, so keyboard/AT users need the button. `Esc`
    while a toast is focused dismisses it. Never steal focus on toast arrival.
- **Reduced motion.** Respect `prefers-reduced-motion: reduce` both in CSS and in
  the JS exit path:

  ```css
  @media (prefers-reduced-motion: reduce) {
    .toast { animation: none; }                 /* no slide-in */
    .toast, .toast.leaving { transition: opacity 120ms linear; transform: none; }
  }
  ```

  And guard the JS (like `usePaneTransitions.js:4`): if reduced-motion, drop the
  transform-based exit and `dismiss(id)` on a plain opacity fade / immediately —
  otherwise the missing `transform` transition means `transitionend` never fires
  and the toast leaks. Drag still functions; only its snap-back transition is
  removed.
- **Tab hidden.** Optional: pause all timers on `document.hidden`
  (`visibilitychange`) so a backgrounded tab doesn't silently expire a batch.
  Note as nice-to-have, not required.

---

## 6. Implementation plan (ordered)

1. **CSS.** Append a `TOASTS` section to `src/styles.css`: `--z-toast` (a value
   above cmdk's 500 — e.g. `1000`), `.toast-viewport` (fixed top-right, flex
   column, `gap`, `pointer-events` only on cards), `.toast` reusing the
   `.glass-pop` recipe (`styles.css:4484`) with a `--tone` var, severity
   modifiers mapping `--err`/`--warn`/`--accent`, `@keyframes toast-in`, the
   `.dragging`/`.leaving` rules, and the reduced-motion block.
   → *verify:* class names render, dark + light both legible.
2. **Store.** Add `src/state/toastStore.js` (§3 shape) with the counter, `MAX`
   cap, and `_resetToasts`.
   → *verify:* `src/state/toastStore.test.js` (mirror `ptyPanelStore.test.js`):
   push adds; `getToasts` is a stable ref between non-mutating reads; cap evicts
   oldest; `dismiss`/`clear` work; `beginExit` flips `leaving`.
3. **Facade.** Add `src/lib/notify.js` exporting `notify` (§2).
4. **Hook.** Add `src/hooks/useToasts.js` → `useSyncExternalStore(subscribe, getToasts)`.
5. **Toast.** Add `src/components/toast/Toast.jsx`: timer (pause/resume), drag
   (setPointerCapture, right-only), exit (`beginExit`→`transitionend`→`dismiss`
   with reduced-motion fallback), aria + close button.
6. **Viewport.** Add `src/components/toast/ToastViewport.jsx`: `useToasts()`,
   `createPortal` to `document.body`, the two aria-live sub-regions, map → `<Toast>`.
7. **Mount.** Add `<ToastViewport />` to `Shell` in `src/App.jsx` (§3).
8. **Smoke-wire one real producer** (out of scope for this design, but the
   natural first caller): a `notify.error(...)` in an `api/client.js` failure
   path or the push-failure branch, to prove cross-module use.
9. **Verify:** `cd app/ui && npm test` (vitest — store test green) and
   `cd app/ui && npm run build` (bundle clean). Manual: fire all three severities,
   confirm slide-in, 3s auto-out, hover-pause, drag-right dismiss, reduced-motion.

---

## 7. Assumptions / forks

- **State lib.** No fork to resolve — the codebase's own singleton +
  `useSyncExternalStore` pattern is the clear match; no third-party toast lib
  (react-hot-toast/sonner) is warranted and none is present. Adding one would
  violate the "match existing state pattern" instruction.
- **Newest position.** Assumed **newest-on-top**; trivial to flip to bottom by
  reversing the render map — no store change.
- **Cap = 4, duration = 3000ms.** Taken from the operator's "~3 seconds"; both
  are single constants in the store, easy to tune or make per-call via `opts`.
- **Portal vs plain fixed.** Recommended portal-to-body for guaranteed top-layer
  stacking above modals; a plain fixed `.toast-viewport` mounted in `Shell` also
  works (like `MonitorWidget`) if a portal is deemed unnecessary — the z-index
  above 500 is the real requirement.
