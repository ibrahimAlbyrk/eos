// Pure zoom→appearance math for the renderer's background dot-grid. The grid must
// FADE as you zoom out (so a low-zoom canvas doesn't read as a dense, cluttered
// mass) and RESOLVE crisply as you zoom in — React Flow's background feel. Two
// independent, DOM-free mappings so they unit-test beside viewport.js:
//   - gridOpacity(zoom): smoothstep fade — full at/above the default zoom, easing
//     to 0 once the canvas is zoomed far out.
//   - gridGap(zoom, base): level-of-detail gap that doubles each time zoom halves
//     below 1, so the dots' SCREEN spacing (gap*zoom) stays near `base` instead of
//     packing into a dense mass at low zoom.
// The caller applies opacity as a plain SVG attribute and the gap as the
// userSpaceOnUse pattern size — no will-change / transform / layer-promotion, so
// the vector engine re-rasterizes the dots every frame and they stay sharp.

// Below FADE_HIDE the grid is fully hidden; at/above FADE_FULL it is fully shown.
export const FADE_HIDE = 0.35;
export const FADE_FULL = 0.85;

// Hermite smoothstep: 0 below edge0, 1 above edge1, eased (no hard cut) between.
function smoothstep(edge0, edge1, x) {
  if (edge1 === edge0) return x < edge0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// Grid opacity for a zoom level — fades 0→1 across [FADE_HIDE, FADE_FULL].
export function gridOpacity(zoom) {
  return smoothstep(FADE_HIDE, FADE_FULL, zoom);
}

// Level-of-detail gap: the flow-space dot spacing, doubled once per halving of
// zoom below 1 so screen spacing (gap*zoom) hovers near `base` rather than
// collapsing. Never finer than `base` — zooming IN only spreads dots apart, which
// reads fine. Returns base * 2^n.
export function gridGap(zoom, base = 22) {
  if (!(zoom > 0)) return base;
  const levels = Math.max(0, Math.round(-Math.log2(zoom)));
  return base * 2 ** levels;
}
