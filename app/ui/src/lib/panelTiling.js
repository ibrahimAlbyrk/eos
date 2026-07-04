// Pure tiling engine for the per-pane right-panel dock. Mirrors lib/paneLayout's
// contract (pure %-rect geometry + immutable list ops, no React) so the renderer
// (PanelDock) is a pure function of computePanelRects/computePanelHandles and the
// store just holds the dock object.
//
// A dock:
//   { slots: [{ type, data, seq }], nextSeq, ratios: { v, col } }
// The slot ARRAY INDEX is the visual position (0/1/2 → the tiles below); `seq` is
// a monotonic open counter used only for eviction recency. The two are decoupled
// on purpose: same-type reuse keeps a panel's slot index (no jump) while bumping
// its seq. Ratios are POSITIONAL (attached to the split boundaries, not to any
// panel) so they survive reuse and replace-most-recent untouched.
//
// Layout discipline (settled): cap 3. 1 = full; 2 = vertical stack (top/bottom);
// 3 = left column holds the stacked pair, right column is one full-height panel.
// A 4th distinct open evicts the most-recently-opened panel and takes its slot.

export const PANEL_CAP = 3;

const RATIO_MIN = 0.15;
const RATIO_MAX = 0.85;
export const clampRatio = (r) => Math.min(RATIO_MAX, Math.max(RATIO_MIN, r));

export const DEFAULT_RATIOS = { v: 0.5, col: 0.5 };

export function emptyDock() {
  return { slots: [], nextSeq: 0, ratios: { ...DEFAULT_RATIOS } };
}

// ── list ops ───────────────────────────────────────────────────────────────

// Open (or reuse) a panel. Returns { dock, evicted } — evicted is the type pushed
// out of the dock (for its onClose side-effect), or null.
//   1. type already open  → reuse in place: swap data, bump seq, slot index kept.
//   2. under cap          → append a new slot (grows 1→2→3), it is most-recent.
//   3. at cap, new type   → evict the max-seq (most-recently-opened) slot; the
//                           newcomer takes that exact slot index, ratios untouched.
export function openPanelTile(dock, type, data) {
  const slots = dock.slots;
  const idx = slots.findIndex((s) => s.type === type);
  if (idx !== -1) {
    const next = slots.slice();
    next[idx] = { type, data, seq: dock.nextSeq };
    return { dock: { ...dock, slots: next, nextSeq: dock.nextSeq + 1 }, evicted: null };
  }
  if (slots.length < PANEL_CAP) {
    const next = [...slots, { type, data, seq: dock.nextSeq }];
    return { dock: { ...dock, slots: next, nextSeq: dock.nextSeq + 1 }, evicted: null };
  }
  let m = 0;
  for (let i = 1; i < slots.length; i++) if (slots[i].seq > slots[m].seq) m = i;
  const evicted = slots[m].type;
  const next = slots.slice();
  next[m] = { type, data, seq: dock.nextSeq };
  return { dock: { ...dock, slots: next, nextSeq: dock.nextSeq + 1 }, evicted };
}

// Close a panel by type; the slot is removed and later slots shift down (reflow).
// Returns { dock, closed }. Same dock reference when the type is absent.
export function closePanelTile(dock, type) {
  const idx = dock.slots.findIndex((s) => s.type === type);
  if (idx === -1) return { dock, closed: false };
  const next = dock.slots.slice();
  next.splice(idx, 1);
  return { dock: { ...dock, slots: next }, closed: true };
}

// Update a panel's data in place (a buried viewer that keeps live-syncing). Same
// reference when the type is absent or the updater returns the same data.
export function updatePanelTileData(dock, type, updater) {
  const idx = dock.slots.findIndex((s) => s.type === type);
  if (idx === -1) return dock;
  const data = updater(dock.slots[idx].data);
  if (data === dock.slots[idx].data) return dock;
  const next = dock.slots.slice();
  next[idx] = { ...next[idx], data };
  return { ...dock, slots: next };
}

export function hasPanelTile(dock, type) {
  return dock.slots.some((s) => s.type === type);
}

export function panelTileData(dock, type) {
  return dock.slots.find((s) => s.type === type)?.data ?? null;
}

export function panelTypes(dock) {
  return dock.slots.map((s) => s.type);
}

// Set one positional ratio ('v' | 'col'), clamped. Same reference when unchanged.
export function setDockRatio(dock, key, value) {
  const r = clampRatio(value);
  if (dock.ratios[key] === r) return dock;
  return { ...dock, ratios: { ...dock.ratios, [key]: r } };
}

// ── geometry ─────────────────────────────────────────────────────────────────

const FULL = { left: 0, top: 0, width: 100, height: 100 };

// The tree → flat %-rectangles, one per slot, keyed by type. The renderer
// positions each tile absolutely from these, so a reflow (open/close/replace)
// never re-parents a tile — only its rect moves (keep-alive; the PTY invariant).
export function computePanelRects(slots, ratios = DEFAULT_RATIOS) {
  const n = slots.length;
  const v = clampRatio(ratios.v ?? DEFAULT_RATIOS.v);
  const col = clampRatio(ratios.col ?? DEFAULT_RATIOS.col);
  if (n === 0) return [];
  if (n === 1) return [{ type: slots[0].type, rect: { ...FULL } }];
  if (n === 2) {
    return [
      { type: slots[0].type, rect: { left: 0, top: 0, width: 100, height: 100 * v } },
      { type: slots[1].type, rect: { left: 0, top: 100 * v, width: 100, height: 100 * (1 - v) } },
    ];
  }
  // n === 3: left column stacks slots[0]/[1] by v; right column is slots[2].
  const cw = 100 * col;
  return [
    { type: slots[0].type, rect: { left: 0, top: 0, width: cw, height: 100 * v } },
    { type: slots[1].type, rect: { left: 0, top: 100 * v, width: cw, height: 100 * (1 - v) } },
    { type: slots[2].type, rect: { left: cw, top: 0, width: 100 - cw, height: 100 } },
  ];
}

// One handle per active split. Normalized geometry the renderer maps to CSS:
//   axis 'y' (horizontal handle, ns-resize): style { top: pos%, left: cross%, width: crossLen% }
//   axis 'x' (vertical handle,  ew-resize): style { left: pos%, top: cross%, height: crossLen% }
// The v handle at n=3 spans only the LEFT column (crossLen = col); the col handle
// spans the full height. n<2 has no split, so no handle.
export function computePanelHandles(count, ratios = DEFAULT_RATIOS) {
  const v = clampRatio(ratios.v ?? DEFAULT_RATIOS.v);
  const col = clampRatio(ratios.col ?? DEFAULT_RATIOS.col);
  if (count < 2) return [];
  if (count === 2) {
    return [{ id: "v", axis: "y", pos: 100 * v, cross: 0, crossLen: 100 }];
  }
  return [
    { id: "v", axis: "y", pos: 100 * v, cross: 0, crossLen: 100 * col },
    { id: "col", axis: "x", pos: 100 * col, cross: 0, crossLen: 100 },
  ];
}

// ── clamps ───────────────────────────────────────────────────────────────────

// Two-sided clamp for a divider drag: keep NEITHER adjacent panel below its px
// min. minA/minB are the two panels' px minimums along the drag axis; containerPx
// is that axis's live size. Falls back to the fractional RATIO clamp when the px
// bounds are looser. Degenerate (both mins can't fit): return the proportional
// split so the divider freezes at a stable spot instead of oscillating.
export function clampSplit(frac, minAPx, minBPx, containerPx) {
  if (!(containerPx > 0)) return clampRatio(frac);
  const lo = Math.max(RATIO_MIN, minAPx / containerPx);
  const hi = Math.min(RATIO_MAX, 1 - minBPx / containerPx);
  if (lo > hi) {
    const sum = minAPx + minBPx;
    return sum > 0 ? minAPx / sum : 0.5;
  }
  return Math.min(hi, Math.max(lo, frac));
}

// Can a 3-panel dock host two side-by-side columns at their px minimums? Used at
// open time to refuse a 3rd panel that would crush a column (caller notifies and
// no-ops, like splitLeaf at MAX_PANES). Caller fails OPEN when width is unknown.
export function canFitColumns(dockWidthPx, leftMinPx, rightMinPx) {
  return dockWidthPx >= leftMinPx + rightMinPx;
}
