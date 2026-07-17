// Pure tiling engine for the per-pane right-panel dock. Mirrors lib/paneLayout's
// contract (pure %-rect geometry + immutable list ops, no React) so the renderer
// (PanelDock) is a pure function of computePanelRects/computePanelHandles and the
// store just holds the dock object.
//
// A dock:
//   { slots: [{ type, data, seq }], nextSeq, ratios: { v0..v2, c0..c1 } }
// The slot ARRAY INDEX is the visual position (see the fill order below); `seq` is
// a monotonic open counter used only for eviction recency. The two are decoupled
// on purpose: same-type reuse keeps a panel's slot index (no jump) while bumping
// its seq. Ratios are POSITIONAL (attached to the split boundaries, not to any
// panel) so they survive reuse and replace-most-recent untouched.
//
// Layout discipline (column-of-stacks): columns grow rightward, each column holds
// at most 2 vertically stacked panels; cap 6 (3 columns × 2). Fill order — a new
// panel opens as a single new right column, the next stacks below it, the next
// starts another column, and so on:
//   1 → one full column; 2 → one stacked column; 3 → stacked pair + right single;
//   4 → 2 stacked columns; 5 → 2 stacked + right single; 6 → 3 stacked columns.
// Slot index i lives at column floor(i/2), row i%2. A 7th distinct open evicts the
// most-recently-opened panel and takes its slot (in place).
//
// Ratios are POSITIONAL: `v{k}` splits column k's stacked pair (top-panel height
// fraction); `c{k}` is column-boundary k's cumulative x-position (fraction of the
// dock width). Both survive reuse/reflow; per-key defaults come from the geometry.

export const MAX_COLS = 3;
export const COL_CAP = 2;
export const PANEL_CAP = MAX_COLS * COL_CAP;

const RATIO_MIN = 0.15;
const RATIO_MAX = 0.85;
export const clampRatio = (r) => Math.min(RATIO_MAX, Math.max(RATIO_MIN, r));

// A stacked column's default top/bottom split; column-boundary defaults are
// count-dependent (even splits) and supplied by columnBounds().
export const DEFAULT_V = 0.5;
const MIN_COL_FRAC = 0.1; // floor so a stale stored boundary never inverts a column
export const DEFAULT_RATIOS = { v0: DEFAULT_V, v1: DEFAULT_V, v2: DEFAULT_V };

export function emptyDock() {
  return { slots: [], nextSeq: 0, ratios: { ...DEFAULT_RATIOS } };
}

// ── list ops ───────────────────────────────────────────────────────────────

// Open (or reuse) a panel. Returns { dock, evicted } — evicted is the type pushed
// out of the dock (for its onClose side-effect), or null.
//   1. type already open  → reuse in place: swap data, bump seq, slot index kept.
//   2. under cap          → append a new slot (grows up to PANEL_CAP), most-recent.
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

// Set one positional ratio (v{k} | c{k}), clamped. Same reference when unchanged.
export function setDockRatio(dock, key, value) {
  const r = clampRatio(value);
  if (dock.ratios[key] === r) return dock;
  return { ...dock, ratios: { ...dock.ratios, [key]: r } };
}

// ── geometry ─────────────────────────────────────────────────────────────────

// Group n slots into columns of ≤2 by index: column k holds slots 2k (top) and
// 2k+1 (bottom, when present). e.g. n=5 → [[0,1],[2,3],[4]].
export function columnize(n) {
  const cols = [];
  for (let i = 0; i < n; i++) (cols[Math.floor(i / 2)] ??= []).push(i);
  return cols;
}

// Cumulative column-boundary x-positions (fractions) for n slots. Returns
// { C, xs } where C is the column count and xs has length C+1: column k spans
// [xs[k], xs[k+1]]. Boundary k reads ratios.c{k}, defaulting to an even split
// (k+1)/C; each is clamped strictly increasing with MIN_COL_FRAC of headroom so a
// stale stored ratio can never invert or zero a column.
export function columnBounds(n, ratios = DEFAULT_RATIOS) {
  const C = Math.ceil(n / 2);
  const xs = [0];
  for (let k = 0; k < C - 1; k++) {
    let p = ratios["c" + k];
    if (typeof p !== "number") p = (k + 1) / C;
    const lo = xs[k] + MIN_COL_FRAC;
    const hi = 1 - (C - 1 - k) * MIN_COL_FRAC;
    xs.push(Math.min(hi, Math.max(lo, p)));
  }
  xs.push(1);
  return { C, xs };
}

// The dock → flat %-rectangles, one per slot, keyed by type, in slot order. The
// renderer positions each tile absolutely from these, so a reflow (open/close/
// replace) never re-parents a tile — only its rect moves (keep-alive; the PTY
// invariant). A column with 2 slots splits vertically by v{k}; a lone slot fills.
export function computePanelRects(slots, ratios = DEFAULT_RATIOS) {
  const n = slots.length;
  if (n === 0) return [];
  const { C, xs } = columnBounds(n, ratios);
  const out = [];
  for (let k = 0; k < C; k++) {
    const left = 100 * xs[k];
    const width = 100 * (xs[k + 1] - xs[k]);
    const top = 2 * k;
    const bot = 2 * k + 1;
    if (bot < n) {
      const v = clampRatio(ratios["v" + k] ?? DEFAULT_V);
      out.push({ type: slots[top].type, rect: { left, top: 0, width, height: 100 * v } });
      out.push({ type: slots[bot].type, rect: { left, top: 100 * v, width, height: 100 * (1 - v) } });
    } else {
      out.push({ type: slots[top].type, rect: { left, top: 0, width, height: 100 } });
    }
  }
  return out;
}

// One handle per active split. Normalized geometry the renderer maps to CSS:
//   axis 'y' (horizontal handle, ns-resize): style { top: pos%, left: cross%, width: crossLen% }
//   axis 'x' (vertical handle,  ew-resize): style { left: pos%, top: cross%, height: crossLen% }
// Each 2-panel column k gets a v{k} handle spanning only that column's width; each
// column boundary k gets a c{k} handle spanning full height. count<2 → no split.
export function computePanelHandles(count, ratios = DEFAULT_RATIOS) {
  const n = count;
  if (n < 2) return [];
  const { C, xs } = columnBounds(n, ratios);
  const handles = [];
  for (let k = 0; k < C; k++) {
    if (2 * k + 1 < n) {
      const v = clampRatio(ratios["v" + k] ?? DEFAULT_V);
      handles.push({ id: "v" + k, axis: "y", pos: 100 * v, cross: 100 * xs[k], crossLen: 100 * (xs[k + 1] - xs[k]) });
    }
  }
  for (let k = 0; k < C - 1; k++) {
    handles.push({ id: "c" + k, axis: "x", pos: 100 * xs[k + 1], cross: 0, crossLen: 100 });
  }
  return handles;
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

// Two-sided clamp for a COLUMN-BOUNDARY drag (cumulative x-position). Like
// clampSplit but bounded by the neighbor boundaries loBound/hiBound (0/1 at the
// dock edges), so a middle boundary can't cross its neighbors: it keeps the column
// on each side at its px min. Degenerate (mins can't fit the span) → freeze
// proportionally between the neighbor bounds so the divider doesn't oscillate.
export function clampBoundary(frac, leftMinPx, rightMinPx, containerPx, loBound = 0, hiBound = 1) {
  if (!(containerPx > 0)) return clampRatio(frac);
  const lo = Math.max(RATIO_MIN, loBound + leftMinPx / containerPx);
  const hi = Math.min(RATIO_MAX, hiBound - rightMinPx / containerPx);
  if (lo > hi) {
    const sum = leftMinPx + rightMinPx;
    return sum > 0 ? loBound + (hiBound - loBound) * (leftMinPx / sum) : (loBound + hiBound) / 2;
  }
  return Math.min(hi, Math.max(lo, frac));
}

// Can a dock host these columns side by side at their px minimums? colMinsPx is
// one min width per column (after the pending open). Used at open time to refuse a
// panel that would add a column the dock can't fit (caller notifies and no-ops,
// like splitLeaf at MAX_PANES). Caller fails OPEN when width is unknown.
export function canFitColumns(dockWidthPx, colMinsPx) {
  return dockWidthPx >= colMinsPx.reduce((sum, m) => sum + m, 0);
}
