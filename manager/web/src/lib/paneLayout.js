// Pure BSP (binary space partition) layout for the split view. The layout is a
// tree of leaves (one agent each) and splits (two children + a ratio). This is
// the single source of every layout transform — no React — so PaneProvider just
// owns the tree and orchestrates the selectedId side effect, and the renderer is
// a pure function of computeRects/computeDividers.
//
//   leaf:  { t:"leaf",  id, agentId }                        — a pane
//   split: { t:"split", id, dir:"row"|"col", ratio, a, b }   — dir "row" = a|b
//          side-by-side (vertical divider); "col" = a/b stacked. ratio = a's share.

export const MAX_PANES = 9;

const RATIO_MIN = 0.15;
const RATIO_MAX = 0.85;
const clampRatio = (r) => Math.min(RATIO_MAX, Math.max(RATIO_MIN, r));

// Unique, reload-collision-safe node ids without a crypto dependency (tests run
// under node). The random suffix keeps fresh ids distinct from a loaded tree's.
let _seq = 0;
const nid = () => `p${_seq++}_${Math.random().toString(36).slice(2, 8)}`;

export const leaf = (agentId = null) => ({ t: "leaf", id: nid(), agentId });
const mkSplit = (dir, a, b, ratio = 0.5) => ({ t: "split", id: nid(), dir, ratio, a, b });
export const isLeaf = (n) => n && n.t === "leaf";

export function isValidTree(n) {
  if (!n || typeof n !== "object") return false;
  if (n.t === "leaf") return typeof n.id === "string";
  if (n.t === "split") {
    return typeof n.id === "string"
      && (n.dir === "row" || n.dir === "col")
      && typeof n.ratio === "number"
      && isValidTree(n.a) && isValidTree(n.b);
  }
  return false;
}

// Ordered (DFS, a before b) list of leaf nodes — the flat view consumers use.
export function leaves(node) {
  return isLeaf(node) ? [node] : [...leaves(node.a), ...leaves(node.b)];
}
export const leafCount = (node) => leaves(node).length;

export function findLeaf(node, id) {
  if (isLeaf(node)) return node.id === id ? node : null;
  return findLeaf(node.a, id) || findLeaf(node.b, id);
}

export function leafOfAgent(node, agentId) {
  if (agentId == null) return null;
  return leaves(node).find((l) => l.agentId === agentId) ?? null;
}

// Immutable rebuild that replaces the matched leaf via fn. Returns the same
// reference when nothing changed so React can bail.
function mapLeaf(node, id, fn) {
  if (isLeaf(node)) return node.id === id ? fn(node) : node;
  const a = mapLeaf(node.a, id, fn);
  const b = mapLeaf(node.b, id, fn);
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

export function setLeafAgent(tree, leafId, agentId) {
  return mapLeaf(tree, leafId, (l) => (l.agentId === agentId ? l : { ...l, agentId }));
}

// Split a leaf into [existing, fresh] along dir; `side` ("before"|"after") places
// the new leaf. Returns { tree, newId }. No-op (same tree, null id) at the cap.
export function splitLeaf(tree, leafId, dir, side, agentId) {
  if (leafCount(tree) >= MAX_PANES || !findLeaf(tree, leafId)) return { tree, newId: null };
  const fresh = leaf(agentId);
  const next = mapLeaf(tree, leafId, (l) => {
    const [a, b] = side === "before" ? [fresh, l] : [l, fresh];
    return { t: "split", id: nid(), dir, ratio: 0.5, a, b };
  });
  return { tree: next, newId: fresh.id };
}

// Remove a leaf; its parent split collapses to the sibling. Removing the only
// leaf is a no-op (the tree always keeps ≥1 pane).
export function removeLeaf(tree, leafId) {
  if (isLeaf(tree)) return tree;
  const walk = (n) => {
    if (isLeaf(n)) return n;
    if (isLeaf(n.a) && n.a.id === leafId) return n.b;
    if (isLeaf(n.b) && n.b.id === leafId) return n.a;
    const a = walk(n.a);
    const b = walk(n.b);
    return a === n.a && b === n.b ? n : { ...n, a, b };
  };
  return walk(tree);
}

export function setRatio(tree, splitId, ratio) {
  const r = clampRatio(ratio);
  const walk = (n) => {
    if (isLeaf(n)) return n;
    if (n.id === splitId) return n.ratio === r ? n : { ...n, ratio: r };
    const a = walk(n.a);
    const b = walk(n.b);
    return a === n.a && b === n.b ? n : { ...n, a, b };
  };
  return walk(tree);
}

// Remove every leaf whose agent has died (isAlive false), collapsing each split
// to its sibling — but keep deliberately-empty (null) leaves, and never drop
// below one pane (the last dying leaf is emptied instead). Reuses removeLeaf /
// setLeafAgent so surviving splits keep their ratios. Same ref when unchanged.
export function removeDeadLeaves(tree, isAlive) {
  let t = tree;
  for (const l of leaves(tree)) {
    if (l.agentId != null && !isAlive(l.agentId)) {
      t = leafCount(t) > 1 ? removeLeaf(t, l.id) : setLeafAgent(t, l.id, null);
    }
  }
  return t;
}

// A row of equal-width columns, as nested binary row-splits: the first takes
// 1/N, the rest share the remainder equally → every column ends up 1/N.
function rowOf(ids) {
  if (ids.length === 1) return leaf(ids[0]);
  return mkSplit("row", leaf(ids[0]), rowOf(ids.slice(1)), 1 / ids.length);
}

// Tile ids into up to two equal rows of ceil(N/2) columns each, top row first:
// 2 → stacked, 3 → 2-over-1, 4 → 2×2, 6 → 3-over-3.
function gridOf(ids) {
  if (ids.length <= 1) return rowOf(ids);
  const cols = Math.ceil(ids.length / 2);
  return mkSplit("col", rowOf(ids.slice(0, cols)), rowOf(ids.slice(cols)), 0.5);
}

// "Open children": the orchestrator on the left (a narrower 40% so the children
// get more room), its children tiled on the right to best-fit the count — two
// equal rows of ceil(N/2) (2 → stacked, 4 → 2×2, 6 → 3-over-3). Capped at
// FANOUT_MAX panes total.
const FANOUT_MAX = 7; // orchestrator + up to 6 children
const FANOUT_RATIO = 0.4; // orchestrator's share of the width; the rest is the children grid

export function fanoutLayout(parentId, childIds) {
  const kids = childIds.slice(0, FANOUT_MAX - 1);
  if (kids.length === 0) return leaf(parentId);
  return mkSplit("row", leaf(parentId), gridOf(kids), FANOUT_RATIO);
}

// Built-in starter layouts seeded on first run (structure only — empty leaves; an
// applied preset re-homes the current agents via fillAgents). Names are user-facing.
//   Single        — one pane
//   Double        — two side by side
//   Triple        — three equal columns
//   Multi Tasking — 4-over-4 grid (eight panes)
//   Agent Swarm   — one pane on the left (40%) + a 3-over-3 grid on the right
export function defaultPanePresets() {
  const empties = (n) => Array.from({ length: n }, () => null);
  return [
    { name: "Single", tree: leaf() },
    { name: "Double", tree: rowOf(empties(2)) },
    { name: "Triple", tree: rowOf(empties(3)) },
    { name: "Multi Tasking", tree: gridOf(empties(8)) },
    { name: "Agent Swarm", tree: fanoutLayout(null, empties(6)) },
  ];
}

// A layout preset is structure only (no agents): strip every leaf's agent.
export function stripAgents(tree) {
  if (isLeaf(tree)) return { ...tree, agentId: null };
  return { ...tree, a: stripAgents(tree.a), b: stripAgents(tree.b) };
}

// Apply a structure to a set of agents: clone it with FRESH node ids and fill the
// leaves (DFS order) with `agents` — extra agents are dropped, extra leaves stay
// empty. This is how presets re-home the current agents into a saved split shape.
export function fillAgents(tree, agents) {
  let i = 0;
  const walk = (n) => (isLeaf(n)
    ? leaf(agents[i++] ?? null)
    : mkSplit(n.dir, walk(n.a), walk(n.b), n.ratio));
  return walk(tree);
}

// Geometry: the tree → flat %-rectangles, one per leaf (and one divider per
// split). The renderer positions panes absolutely from these, so a structural
// edit never remounts a surviving leaf (keep-alive) — only its rect moves.
const FULL = { left: 0, top: 0, width: 100, height: 100 };

export function computeRects(node, rect = FULL) {
  if (isLeaf(node)) return [{ id: node.id, agentId: node.agentId, rect }];
  const { left, top, width, height } = rect;
  if (node.dir === "row") {
    const wA = width * node.ratio;
    return [
      ...computeRects(node.a, { left, top, width: wA, height }),
      ...computeRects(node.b, { left: left + wA, top, width: width - wA, height }),
    ];
  }
  const hA = height * node.ratio;
  return [
    ...computeRects(node.a, { left, top, width, height: hA }),
    ...computeRects(node.b, { left, top: top + hA, width, height: height - hA }),
  ];
}

// Drop-to-split geometry: which zone a point (fx, fy ∈ 0..1 within a pane) maps
// to. The nearest edge wins when within `edge` of it (triangular zones radiating
// from the center); otherwise the center → replace the pane's agent. Edge →
// split: left/right = vertical (dir "row"), top/bottom = horizontal ("col");
// before = left/top, after = right/bottom.
export function dropZoneFromPoint(fx, fy, edge = 0.3) {
  const d = { left: fx, right: 1 - fx, top: fy, bottom: 1 - fy };
  let nearest = "left";
  for (const k of ["right", "top", "bottom"]) if (d[k] < d[nearest]) nearest = k;
  if (d[nearest] >= edge) return { kind: "replace" };
  const dir = nearest === "left" || nearest === "right" ? "row" : "col";
  const side = nearest === "left" || nearest === "top" ? "before" : "after";
  return { kind: "split", dir, side, edge: nearest };
}

export function computeDividers(node, rect = FULL) {
  if (isLeaf(node)) return [];
  const { left, top, width, height } = rect;
  if (node.dir === "row") {
    const wA = width * node.ratio;
    return [
      { id: node.id, dir: "row", rect, pos: left + wA },
      ...computeDividers(node.a, { left, top, width: wA, height }),
      ...computeDividers(node.b, { left: left + wA, top, width: width - wA, height }),
    ];
  }
  const hA = height * node.ratio;
  return [
    { id: node.id, dir: "col", rect, pos: top + hA },
    ...computeDividers(node.a, { left, top, width, height: hA }),
    ...computeDividers(node.b, { left, top: top + hA, width, height: height - hA }),
  ];
}
