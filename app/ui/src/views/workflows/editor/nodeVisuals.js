// The node-kind VISUAL identity map — the single pure source for how each of the
// 14 graph node kinds reads on the canvas: its category, the category accent token
// (--wfk-*, defined in styles.css), and a 16px line-glyph icon. Kept DOM-free so
// it unit-tests in the repo's node env beside graphModel.js / catalog.js; KindIcon
// renders the descriptors and the CSS resolves the accent var into the card rail.
//
// Kind identity is carried by a category accent (left rail + tinted icon), NOT a
// flooded card — so run-state border coloring (--ok/--warn/--err) reads cleanly on
// top. The status hues stay RESERVED for run state; categories use --wfk-* only.

export const NODE_CATEGORIES = ["io", "compute", "transform", "control", "composite"];

// kind → category. Mirrors core/domain/workflow-node-catalog.ts so the two never
// disagree; the catalog also ships category over the wire, this is the offline map.
const KIND_CATEGORY = {
  input: "io",
  output: "io",
  worker: "compute",
  script: "compute",
  transform: "transform",
  map: "transform",
  filter: "transform",
  dedup: "transform",
  tally: "transform",
  accumulate: "transform",
  branch: "control",
  merge: "control",
  loop: "control",
  subGraph: "composite",
};

// category → the editor-scoped accent token (defined once in :root + light theme).
const CATEGORY_ACCENT = {
  io: "--wfk-io",
  compute: "--wfk-compute",
  transform: "--wfk-transform",
  control: "--wfk-control",
  composite: "--wfk-composite",
};

// Per-kind line glyphs, lucide-style: 24×24 viewBox, currentColor, no fill. Each
// icon is an array of plain element descriptors so the data stays testable and
// KindIcon maps it to SVG elements. `t` is the tag; coords are viewBox units.
const KIND_ICON = {
  input: [
    { t: "path", d: "M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" },
    { t: "path", d: "m10 17 5-5-5-5" },
    { t: "path", d: "M15 12H3" },
  ],
  output: [
    { t: "path", d: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" },
    { t: "path", d: "m16 17 5-5-5-5" },
    { t: "path", d: "M21 12H9" },
  ],
  worker: [
    { t: "path", d: "M12 8V4H8" },
    { t: "rect", x: 4, y: 8, w: 16, h: 12, rx: 2 },
    { t: "line", x1: 2, y1: 14, x2: 4, y2: 14 },
    { t: "line", x1: 20, y1: 14, x2: 22, y2: 14 },
    { t: "line", x1: 9, y1: 13, x2: 9, y2: 15 },
    { t: "line", x1: 15, y1: 13, x2: 15, y2: 15 },
  ],
  script: [
    { t: "path", d: "m4 17 6-6-6-6" },
    { t: "line", x1: 12, y1: 19, x2: 20, y2: 19 },
  ],
  transform: [
    { t: "path", d: "M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.13-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.13a.5.5 0 0 1 .96 0L14.06 8.5A2 2 0 0 0 15.5 9.94l6.13 1.58a.5.5 0 0 1 0 .96L15.5 14.06a2 2 0 0 0-1.44 1.44l-1.58 6.13a.5.5 0 0 1-.96 0z" },
    { t: "path", d: "M20 3v4" },
    { t: "path", d: "M22 5h-4" },
  ],
  map: [
    { t: "line", x1: 3, y1: 6, x2: 14, y2: 6 },
    { t: "line", x1: 3, y1: 12, x2: 14, y2: 12 },
    { t: "line", x1: 3, y1: 18, x2: 14, y2: 18 },
    { t: "path", d: "m18 9 3 3-3 3" },
  ],
  filter: [{ t: "path", d: "M22 3H2l8 9.46V19l4 2v-8.54L22 3z" }],
  dedup: [
    { t: "rect", x: 9, y: 9, w: 12, h: 12, rx: 2 },
    { t: "path", d: "M5 15a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2" },
  ],
  tally: [
    { t: "line", x1: 4, y1: 9, x2: 20, y2: 9 },
    { t: "line", x1: 4, y1: 15, x2: 20, y2: 15 },
    { t: "line", x1: 10, y1: 3, x2: 8, y2: 21 },
    { t: "line", x1: 16, y1: 3, x2: 14, y2: 21 },
  ],
  accumulate: [{ t: "path", d: "M18 7V4H6l6 8-6 8h12v-3" }],
  branch: [
    { t: "line", x1: 6, y1: 3, x2: 6, y2: 15 },
    { t: "circle", cx: 18, cy: 6, r: 3 },
    { t: "circle", cx: 6, cy: 18, r: 3 },
    { t: "path", d: "M18 9a9 9 0 0 1-9 9" },
  ],
  merge: [
    { t: "circle", cx: 18, cy: 18, r: 3 },
    { t: "circle", cx: 6, cy: 6, r: 3 },
    { t: "path", d: "M6 21V9a9 9 0 0 0 9 9" },
  ],
  loop: [
    { t: "path", d: "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" },
    { t: "path", d: "M21 3v5h-5" },
    { t: "path", d: "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" },
    { t: "path", d: "M8 16H3v5" },
  ],
  subGraph: [
    { t: "rect", x: 3, y: 3, w: 18, h: 18, rx: 2 },
    { t: "rect", x: 8, y: 8, w: 8, h: 8, rx: 1 },
  ],
};

export function kindCategory(kind) {
  return KIND_CATEGORY[kind] || "compute";
}

export function categoryAccentVar(category) {
  return CATEGORY_ACCENT[category] || CATEGORY_ACCENT.compute;
}

export function kindAccentVar(kind) {
  return categoryAccentVar(kindCategory(kind));
}

// Icon descriptors for a kind; falls back to the worker glyph for an unknown kind
// so a future node kind never renders an empty header slot.
export function kindIcon(kind) {
  return KIND_ICON[kind] || KIND_ICON.worker;
}

// The full node-card className: base + category accent class + selection + run
// state. State coloring layers over the neutral card so the category rail survives
// underneath (selected → accent ring, running/passed/failed/skipped → status hue).
export function nodeCardClass(kind, { selected = false, status = null } = {}) {
  return [
    "wf-rf-node",
    "wf-rf-node--cat-" + kindCategory(kind),
    selected ? "wf-rf-node--selected" : "",
    status ? "wf-rf-node--" + status : "",
  ]
    .filter(Boolean)
    .join(" ");
}
