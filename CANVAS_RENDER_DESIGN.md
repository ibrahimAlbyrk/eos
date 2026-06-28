# Workflow-editor renderer swap — eliminating in-motion node blur

**Status:** design only. No runtime/editor/CSS code is changed by this document.
**Goal:** the workflow-editor's HTML node cards (`.wf-rf-node`) blur during zoom/pan.
Render nodes blur-free with the **least loss of the current HTML-node features**, keeping
the contracts/data model intact (renderer swap, not a data-model change).
**Author's note:** the operator decided on *canvas-based* rendering and accepts a rewrite.
This doc honors that intent and also discharges the explicit instruction to "find the
least-invasive route to TRULY zero in-motion blur and scope it honestly" — so it surfaces a
substrate (SVG) that loses less than canvas, and makes the substrate a late, reversible choice
behind one shared renderer. The operator gets a clean go/no-go either way.

---

## 1. Why the cards blur (root cause, confirmed)

React Flow (`@xyflow/react@12.11.1`, `@xyflow/system@0.0.78`; deps `classcat@^5.0.3`,
`zustand@^4.4.0` — `app/ui/package.json`) renders the graph by putting **one CSS transform**
(`transform: translate(x,y) scale(z)`) on `.react-flow__viewport` and parenting every node's
HTML DOM under it. Pan/zoom is a `d3-zoom` gesture that mutates that transform each frame
(`reactflow.dev/learn/concepts/the-viewport`).

During an active gesture the browser compositor promotes the transformed subtree to a GPU
layer and **scales the cached raster of that layer** for the gesture's duration instead of
re-painting the DOM at the live scale — so text/edges drawn into the cached bitmap upscale and
blur (worst when zoomed in, `scale > 1`, where a 1× raster is magnified). At rest it repaints
crisply. This is intrinsic to transform-zoomed **DOM**; it is not a missing-CSS bug.

The repo has already fought this and the fix attempts are encoded in CSS comments:
- No `will-change`/layer promotion on nodes — `app/ui/src/styles.css:8622-8624` ("a composited
  card is rasterized at 1× and the viewport zoom upscales that bitmap, so it blurs while
  dragging when zoomed in").
- Hover cue is shadow-only, no `transform` — `styles.css:8610-8611`.
- Integer-snap the viewport on `onMoveEnd` to kill *at-rest* fractional-translate blur
  (xyflow #3282) — `FlowCanvas.jsx:185-190`.

These remove *at-rest* blur and avoid making in-motion blur worse, but **cannot** force
per-frame re-rasterization of a transform-scaled DOM subtree mid-gesture. (Note: the
`msg-blur-in 200ms` entrance animation at `styles.css:8597` is a one-shot mount effect, not the
in-motion blur — unrelated.)

### The decisive empirical anchor (from this codebase)

In the *current* editor, **edges are SVG and do not blur**, while only the **HTML cards blur**,
under the *same* viewport transform:
- `WfEdge.jsx:13-22` draws each edge as an SVG `<path>` (`getBezierPath` → `<BaseEdge>`).
- `WfNode.jsx:58-95` draws the card as HTML `<div>`s.

So the blur is specifically an **HTML-compositing** artifact. **SVG and Canvas2D both avoid it**
(vector re-raster / immediate-mode raster at device pixels every frame). This single fact —
visible in the running app — is what makes an all-SVG node renderer a credible *zero-blur*
option, and it grounds the recommendation below.

---

## 2. What the renderer must keep (and what is already renderer-agnostic)

The editor is **already factored for a renderer swap**. Only three files plus the RF-specific
mappers are coupled to React Flow; everything else is renderer-neutral and must survive intact.

**RF-coupled (the swap target):**
- `FlowCanvas.jsx` — the RF `<ReactFlow>` host + interaction→callback wiring (currently being
  worked on per `git status`).
- `WfNode.jsx` — HTML node card + `<Handle>` ports.
- `WfEdge.jsx` — SVG bezier edge.
- `wfConnection.js` + the RF mapper half of `rfAdapter.js` (`toRfNode`/`toRfEdge`/
  `fromRfConnection` — `rfAdapter.js:26-94`).

**Renderer-agnostic (must NOT change — these are the asset base):**
- `contracts/src/workflow-graph.ts` — the v2 graph contract: typed ports (`:94-100`), node incl.
  `ui.{x,y}` layout (`:103-112`), edges (`:118-123`), structural validation (`:194-360`).
  **Stays intact** — this is a renderer swap.
- `graphModel.js` — pure immutable document model + **all the connection rules**
  (`canConnect` `:117-143`, `addEdge`/fan-in `:160-173`, `toWorkflowGraph` `:254-277`,
  copy/paste/duplicate `:284-345`). React/DOM-free, unit-tested in node env.
- `useGraphEditor.js` — reducer + undo stack + the **semantic callbacks the renderer reports
  back through** (`onConnectEdge`/`onReroute`/`onMoveNodes`/`onSelect`/`onAddNodeAt`/
  `onSpawnFromPort`/`onDeleteSelection`/`onRemoveEdge`/`onCopy`/`onPaste`/`onDuplicate`/
  `onUndo`/`onRedo` — `:111-141`). These are renderer-neutral.
- `rfAdapter.js` rule-delegations: `connectionIsValid` (`:98-102`) and `handleReceptivity`
  (`:109-119`) both delegate to `graphModel.canConnect` — reuse verbatim.
- `runEvents.js` — SSE `workflow:step-change` → `nodeStates[nodeId]=status` (`:35-47`). The
  renderer just reads `nodeStates` (already passed into `FlowCanvas` and threaded to
  `data.status` via `toRfNode` `rfAdapter.js:37`). **Live run highlighting is purely data-driven
  and does not change.**
- `nodeVisuals.js` — **`KIND_ICON` descriptors are plain data** (`:44-111`) drawable in any
  substrate; `kindCategory`/`kindAccentVar` (`:113-123`) resolve theming; `nodeCardClass`
  (`:134-143`) is the only DOM-class-string piece.
- `KindIcon.jsx` — already an **SVG** component (`:20-38`) → reusable verbatim in an SVG renderer.
- **Off-canvas UI is unaffected** (this is key): `Inspector.jsx` is a *separate side panel*
  (`GraphEditorSurface.jsx:52-63`); `Palette.jsx` is a side rail using HTML5 DnD
  (`PALETTE_DND_MIME`, `Palette.jsx:7,29-32`); `QuickAddMenu.jsx` is a `position: fixed`
  overlay positioned by `clientX/clientY` (`QuickAddMenu.jsx:28`, `styles.css:8770`). None live
  on the canvas transform. The only renderer touchpoint is `screenToFlowPosition`
  (`FlowCanvas.jsx:141,197,211,229,255`) — a bespoke renderer supplies its own
  screen↔flow inverse-matrix.
- `GraphEditorSurface.jsx` (layout) + `LoopBodyEditor.jsx` (recursive nested editor via the same
  surface) + `WorkflowEditor.jsx` (toolbar/save/load) — unchanged except the one
  `FlowCanvas`→new-renderer import (`GraphEditorSurface.jsx:11,30`).

**Required capability checklist** (each approach is scored against this in §4): pan/zoom · node
drag · multi-select (marquee + shift) · typed-port edges · drag-to-connect port handles + live
receptivity glow · live run highlighting (SSE) · node label + KindIcon · theming. Plus:
accessibility · DPR/HiDPI + WKWebView correctness · read-only mode (Runs view,
`FlowCanvas.jsx:264-323`) · in-flight features (minimap, Controls, fitView, snap-to-grid,
`onlyRenderVisibleElements`).

> **History note.** A pre-RF `Canvas.jsx` existed (deleted in `d25c047`) — but it was an
> HTML-`<div>` scrollable surface with HTML `NodeCard`s + a single SVG edge layer, **no zoom**,
> click-to-connect (not drag). It is **not** a salvageable 2D-canvas renderer. Its `geometry.js`
> `portAnchor()`/`bezier()` math is a useful *reference* for the new scene geometry. The zoom,
> drag-to-connect, marquee, undo, reconnect, and minimap all arrived with React Flow and must be
> re-created by any swap.

---

## 3. Library facts (verified June 2026, not from memory)

| Library | Latest (published) | Render tech | Editor-grade ports + drag-to-connect? | Blur-free zoom? |
|---|---|---|---|---|
| `@xyflow/react` (current) | 12.11.1 | **HTML** nodes + SVG edges | yes (native) | **no** — HTML cards blur in motion |
| `@antv/x6` | 3.1.7 (2026-03-18) | **SVG** + HTML | yes (built-in ports/connect) | SVG nodes: **yes**; HTML/React nodes: **no** |
| `@antv/g6` | 5.1.1 (2026-05-08) | Canvas / SVG / **WebGL** (via `@antv/g`) | partial — viz framework; create-edge behavior, not authoring-first | Canvas/WebGL: yes |
| `litegraph.js` | 0.7.18 (**2024-01, stale**) | **Canvas2D** | yes (node-editor native) | yes |
| `@comfyorg/litegraph` (maintained fork) | 0.17.2 (2025-08) | **Canvas2D** | yes | yes |
| `rete` + `rete-area-plugin` | 2.0.6 / 2.1.5 (2025) | **DOM** (React/Vue/Angular render plugins) | yes | **no** — area-plugin zooms DOM via transform → same blur |
| `sigma` | 3.0.3 (2026-04) | **WebGL** | **no** — graph *visualization* of thousands of nodes; no authoring ports/drag-connect | yes |
| `pixi.js` | 8.19.0 (2026-06) | **WebGL/WebGPU** | no (render engine, not a graph editor) | yes (text needs SDF/atlas) |

**React Flow canvas nodes are not a thing in v12.** Maintainer *moklick* in xyflow discussion
#5446: *"We did some experiments with a canvas renderer for edges but not for nodes yet … it's
currently not very high prioritized."* So "render RF nodes to canvas" (approach 2) has no native
path in 12.11.1.

**Canvas2D / SVG crispness mechanism** (why both reach truly-zero blur): an immediate-mode
2D-canvas redrawn each frame with `ctx.setTransform(dpr·zoom,0,0,dpr·zoom, …)` rasterizes text
and paths at the **final device-pixel size every frame** — never scales a cached bitmap. SVG is
resolution-independent and (when not layer-promoted) is re-rasterized by the vector engine per
frame — exactly why the current SVG edges stay crisp (§1). WebGL is crisp for geometry but
**text is the catch**: it must be drawn via SDF atlases or canvas-texture uploads, which
re-introduce scaling blur unless re-rendered per zoom bucket.

---

## 4. The four approaches — keep/lose matrix

Legend: ✅ kept as-is · 🟡 kept with rework · ❌ lost / not achieved.

| Capability | **A1. Swap to canvas/WebGL library** (G6 / X6-SVG / litegraph) | **A2. Keep RF, cards→canvas** (#5446) | **A3. Bespoke renderer over `graphModel`** (SVG or Canvas2D) | **A4. Hybrid: HTML at rest, raster in motion** |
|---|---|---|---|---|
| **Truly zero in-motion blur** | ✅ (canvas/WebGL or X6-SVG nodes) | 🟡 only via an external canvas synced to RF's transform; drawing *inside* the viewport re-blurs | ✅ | ❌ scaling a frozen raster *is* the blur; only a per-frame vector redraw is crisp = that's A3 |
| pan / zoom | ✅ (built-in) | ✅ (RF) | 🟡 hand-built (wheel-zoom + drag-pan, ~100 lines) | 🟡 (RF or hand-built) |
| node drag | ✅ | ✅ (RF) | 🟡 hand-built (pointer; old `Canvas.jsx` pattern) | ✅ |
| multi-select (marquee+shift) | ✅ | ✅ (RF) | 🟡 hand-built | ✅ |
| typed-port edges | 🟡 re-model into lib's edge type | ✅ (RF edges) | ✅ reuse `graphModel` edges + `getBezierPath`-style path | ✅ |
| drag-to-connect + receptivity glow | 🟡 lib's connect API; re-wire to `canConnect` | ✅ (RF handles) | 🟡 hand-built; **reuses `handleReceptivity`/`canConnect` verbatim** | ✅ |
| live run highlighting (SSE) | 🟡 reimplement on lib node state | 🟡 paint from `nodeStates` | ✅ same `nodeStates`→class/anim path | ✅ |
| label + KindIcon | 🟡 redraw (G6/litegraph: canvas Path2D; X6: SVG) | 🟡 redraw on canvas | ✅ SVG: `KindIcon` verbatim; Canvas: `KIND_ICON` data→Path2D | ✅ |
| theming (CSS vars `--wfk-*`, `.wf-*`) | 🟡 reauthor in lib's style system (or JS color resolve) | ❌→🟡 resolve CSS vars in JS | SVG: ✅ classes/`currentColor`; Canvas: 🟡 `getComputedStyle` resolve | ✅ at rest |
| accessibility (DOM/AT) | ❌ canvas libs; 🟡 X6-SVG | ❌ canvas | SVG: ✅ DOM nodes; Canvas: ❌ (needs ARIA shadow) | ✅ at rest |
| DPR / HiDPI + WKWebView | ✅ lib-handled | 🟡 manual DPR on the overlay | SVG: ✅ resolution-independent, no DPR code; Canvas: 🟡 manual `dpr` backing-store + re-init on DPR change | 🟡 |
| Inspector/Palette/QuickAdd (off-canvas) | 🟡 re-wire selection/DnD to lib events | ✅ (RF events) | ✅ same semantic callbacks + `screenToFlow` shim | ✅ |
| read-only Runs view | 🟡 re-implement gating | ✅ | 🟡 hand-built (flag) | 🟡 |
| **migration effort / risk** | **High** — a 2nd graph model + the lib's own selection/undo/event system alongside `graphModel`/`useGraphEditor`/Zod contracts; theming reauthor; version-coupling risk | **Highest** — keep RF *and* build a canvas renderer + hidden DOM for hit-test; brittle vs RF internals | **Medium** — bounded; reuses model/rules/hook/inspector/palette/quickadd/runevents; build interaction + scene + paint | **High** — two renderers + a swap seam (flicker risk), for no blur win |
| **impact on in-progress files** | replaces `FlowCanvas`/`WfNode`/`WfEdge` **and** displaces `graphModel` usage at the edges | keeps all RF files + adds a parallel renderer | replaces `FlowCanvas`/`WfNode`/`WfEdge` + RF mappers only; rest intact | adds a renderer beside RF |

### Per-approach verdict

- **A1 (library swap).** Achieves zero blur (X6 with **SVG** nodes, G6 canvas/WebGL, litegraph
  Canvas2D), but every zero-blur option forces a **second graph model** plus the library's own
  selection/undo/connect/event system to live next to our pure `graphModel` + `useGraphEditor`
  reducer + Zod `WorkflowGraphSchema`. That is a large two-way-sync + re-theming surface and an
  ongoing version-coupling liability, to buy node/edge/port/zoom features we **already have** in
  `graphModel`. `rete` v2 and `sigma` are eliminated outright: rete renders DOM (blurs), sigma is
  a viz lib with no authoring ports/drag-connect. **Rejected as primary.**
- **A2 (RF + canvas cards).** No native support (maintainer, §3). The only crisp variant is a
  canvas overlay *outside* `.react-flow__viewport` manually synced to RF's transform every
  frame, drawing nodes yourself at live scale — i.e. you build A3's renderer *and still pay for
  RF* and keep hidden DOM nodes for handles/hit-test. Worst complexity-to-benefit; brittle
  against RF internals. **Rejected.**
- **A3 (bespoke renderer over `graphModel`).** Zero blur; keeps the entire renderer-agnostic
  asset base (§2); the only real cost is hand-building the interaction layer (which the RF
  migration added and which we'd otherwise be paying a dependency to provide). **Recommended.**
- **A4 (hybrid).** Does **not** reach zero blur in its cheap form — freezing the HTML to a raster
  and scaling it during the gesture *is* the compositor behavior that blurs. The only crisp
  hybrid redraws vector per frame during the gesture = A3, but with a second at-rest HTML
  renderer and a swap seam bolted on (flicker + double code). Complexity not worth it.
  **Rejected.**

---

## 5. Recommendation

**Build a bespoke renderer over the existing `graphModel`/`useGraphEditor` (drop `@xyflow/react`
entirely), structured as one shared interaction + scene layer with a *swappable paint substrate*.
Paint with SVG first; keep Canvas2D as a drop-in backend behind the same abstraction.**

### Why this shape

- It is the **least-invasive route to truly-zero in-motion blur**: it reuses `graphModel`
  (document + every connection rule), `useGraphEditor` (reducer/undo + all semantic callbacks),
  `Inspector`/`Palette`/`QuickAddMenu` (off-canvas, untouched), `runEvents` (SSE highlighting),
  `nodeVisuals`/`KindIcon` (icons as data/SVG). The swap is contained to `FlowCanvas`/`WfNode`/
  `WfEdge` + the RF mapper half of `rfAdapter`.
- **Why SVG-first (the honest "least-loss" call):** the editor's own SVG edges prove SVG zooms
  crisp under the same transform (§1). SVG keeps the most current HTML-node features at the
  lowest cost — **CSS theming verbatim** (classes + `currentColor` + `--wfk-*` vars), **DOM
  pointer-event hit-testing** (a `pointerdown` on a `<circle class="wf-handle">` *is* the port
  grab — no hand-rolled geometry hit-test for clicks/drag-start/port-grab, which is the single
  biggest code saving vs canvas), **accessibility** (real DOM nodes), **`KindIcon` reused
  verbatim**, and **run-highlight CSS** mostly ports over. SVG is resolution-independent, so DPR
  is a non-issue and WKWebView correctness is free. The only new text concern is manual ellipsis
  (the layout is already fixed-metric: `HEADER_H`/`ROW_H`/`ROW_PAD`, `WfNode.jsx:23-29`).
- **Why keep Canvas2D as a first-class backend (honors the operator's stated preference):** the
  interaction layer, scene model, and screen↔flow math are substrate-agnostic. Choosing the paint
  backend is a **late, reversible decision** — one module. Canvas2D wins only if node counts reach
  the many-hundreds (perf) or pixel-level custom paint is wanted; workflow graphs are tens of
  nodes, so SVG's lower-loss profile dominates today. If the operator wants **pure canvas now**,
  it is the same plan with the Phase-1 paint module written against `<canvas>` instead of `<svg>`
  (then add: JS color resolution via `getComputedStyle`, `dpr` backing-store scaling + re-init on
  DPR change, geometry hit-testing incl. distance-to-bezier, manual `measureText` truncation, and
  an optional offscreen ARIA list for a11y).

### Headline tradeoffs of the recommended path

- **Win:** truly-zero in-motion blur; drops `@xyflow/react` (+`@xyflow/system`+`classcat`+
  `zustand`) for a **smaller editor bundle** and zero new runtime deps (SVG-first); one
  single-sourced rule set (`canConnect`) drives drop-validation, receptivity glow, and backend
  save-validation, unchanged.
- **Cost:** we re-create the interaction behaviors RF gave us for free — wheel-zoom + drag-pan,
  node drag, marquee/shift multi-select, drag-to-connect + reconnect, fitView, snap-to-grid,
  minimap, Controls, and visible-node culling. This is the bulk of the work; it is bounded
  (pointer math is shared across drag/marquee/connect) and most of `FlowCanvas`'s keyboard block
  (`FlowCanvas.jsx:237-262`) ports over verbatim once `screenToFlow` is local.
- **Risk if canvas substrate is chosen instead of SVG:** accessibility regresses to opaque, and
  theming/DPR/hit-testing/text become manual — all solvable, but more code and the classic
  WKWebView DPR footgun if missed.

---

## 6. Phased build plan (files touched · verification)

**Verification convention (state, don't run state-mutating builds):**
`cd app/ui && npm test` (vitest) · `cd app/ui && npm run build` · `npm run lint` (repo root,
dependency-direction). **Never** `eos build` / `eos restart` (restarts the daemon, crashes
running workers — `CLAUDE.md`). Pure modules (`sceneModel`, `viewport`) unit-test in the node
env beside `graphModel.test.js`/`rfAdapter.test.js` per repo convention.

**Phase 0 — Substrate-agnostic seam (no behavior change; RF still live).**
- NEW `viewport.js`: pan/zoom matrix, `screenToFlow`/`flowToScreen`, integer-snap-at-rest. Pure.
- NEW `sceneModel.js`: `toScene(graph, {nodeStates})` → nodes with computed box + port anchors,
  reusing `WfNode` metrics (`:23-29`) and the old `geometry.js portAnchor` math; edges with
  bezier control points. Pure (move the rule-delegations `connectionIsValid`/`handleReceptivity`
  here or keep importing from `rfAdapter`).
- Files: NEW `viewport.js`, `sceneModel.js` (+ `.test.js`). No edits to live runtime.
- Verify: `cd app/ui && npm test`.

**Phase 1 — Bespoke renderer (SVG substrate) behind a flag / parallel mount.**
- NEW `GraphRenderer.jsx`: one `<svg>` viewport `<g transform="matrix(…)">`; nodes as
  `<g class="wf-node …">` (mirror the `.wf-rf-*` classes), edges as `<path>`, handles as
  `<circle class="wf-handle">`, `KindIcon` reused verbatim.
- NEW interaction hook(s): wheel-zoom + drag-pan, node drag, marquee/shift select, port
  drag-to-connect with live wire + receptivity (reuse `handleReceptivity`→`canConnect`),
  reconnect, delete, keyboard (port `FlowCanvas.jsx:237-262`). All report through the **same**
  `useGraphEditor` callbacks. `QuickAddMenu` reused as-is via `viewport.screenToFlow`.
- NEW SVG/CSS: SVG-equivalent of the run-state pulse/ping/shake (`styles.css:8617-8657`) +
  receptivity/reject (`:8684-8691`) — mostly fill/stroke/filter analogues of existing rules.
- Files: NEW `GraphRenderer.jsx` (+ hooks), additive `styles.css` SVG rules; `GraphEditorSurface.jsx`
  swaps `FlowCanvas`→`GraphRenderer` behind a flag (`:11,30`).
- Verify: `cd app/ui && npm test`, `npm run build`, `npm run lint`.

**Phase 2 — Feature parity + read-only + chrome.**
- Minimap (SVG overview), Controls (zoom/fit), `fitView`, snap-to-grid, off-viewport node culling
  (`onlyRenderVisibleElements` equivalent). Read-only parity for the Runs view
  (`FlowCanvas.jsx:264-323` → pan/zoom/fit/minimap only). Loop-body recursion works automatically
  (it goes through `GraphEditorSurface`).
- Files: `GraphRenderer.jsx` + small UI bits; Runs-view graph host.
- Verify: tests + build + lint; **manual:** dev browser **and** Eos.app WKWebView — confirm blur
  gone in motion, run highlighting, drag-to-connect, loop-body overlay, theming in light/dark.

**Phase 3 — Remove React Flow.**
- Delete `FlowCanvas.jsx`, `WfNode.jsx`, `WfEdge.jsx`, `wfConnection.js`; trim the RF mappers from
  `rfAdapter.js` (keep/relocate the rule-delegations); remove the `@xyflow/react` dep + its CSS
  import + the RF-specific `.react-flow__*` rules; drop the integer-snap-on-`moveEnd` workaround
  (now native). Update/retire `rfAdapter.test.js`/`apiWire.test.js` RF references.
- Files: deletions above; `package.json`; `styles.css`.
- Verify: `cd app/ui && npm test` (update RF-specific tests), `npm run build` (confirm `@xyflow`
  gone from the bundle), `npm run lint`.

**Phase 4 (optional, perf-gated) — Canvas2D paint backend.**
- Implement `paint(ctx, scene, viewport)` against the **same** `sceneModel` + interaction layer;
  select substrate by flag. Adds DPR backing-store scaling (+ re-init on DPR change), CSS-var
  color resolution via `getComputedStyle`, geometry hit-testing (incl. distance-to-bezier),
  `measureText` truncation, and an optional offscreen ARIA node list. Only if node counts demand
  it. (If the operator wants pure canvas from the start, this work merges into Phase 1 and SVG is
  skipped.)
- Verify: tests + build + lint; manual WKWebView DPR check on Retina + non-Retina.

**Effort:** ~3 phases to ship (zero-blur parity) + 1 cleanup + 1 optional. Size: **medium-large**,
dominated by the interaction layer; bounded because the document model, rules, undo, inspector,
palette, quick-add, and run-event pipeline all survive untouched.

---

## 7. Open decision for the operator (go/no-go)

1. **Substrate:** **SVG-first** (recommended — least loss, zero new deps, no DPR work, a11y kept)
   *or* **Canvas2D-first** (operator's stated preference — accepts a11y/theming/DPR/hit-test as
   manual work; best at large node counts). Same plan either way; one module differs.
2. Confirm scope excludes the data model (`contracts/src/workflow-graph.ts`, `graphModel.js`) —
   this design keeps them intact.

Everything else (interaction parity list, run-highlight visuals, read-only mode, loop-body
recursion) is specified above and needs no further input to start Phase 0.
