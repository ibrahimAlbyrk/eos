// Pure pan/zoom math for the bespoke workflow renderer — no React, no DOM, no
// graph-library dependency. A viewport is { x, y, zoom }: the surface is translated
// by (x,y) then scaled by `zoom` (screen = flow * zoom + translate), the editor's
// single-transform geometry. screenToFlow / flowToScreen are the inverse pair the
// renderer and QuickAddMenu use to map between screen and flow space; snapViewport
// is the native home of the integer-snap-at-rest fix for the fractional-translate
// blur. Kept DOM-free so it unit-tests in the repo's node env beside
// graphModel.test.js / connectionRules.test.js.
//
// Coordinate contract: the `point` given to screenToFlow is PANE-LOCAL — already
// relative to the canvas element's top-left, NOT clientX/clientY. The renderer
// subtracts getBoundingClientRect() before calling, which keeps this module free
// of any DOM dependency.

export const DEFAULT_VIEWPORT = { x: 0, y: 0, zoom: 1 };

// flow → screen: screen = flow * zoom + translate.
export function flowToScreen(viewport, point) {
  return {
    x: point.x * viewport.zoom + viewport.x,
    y: point.y * viewport.zoom + viewport.y,
  };
}

// screen → flow: the inverse, flow = (screen - translate) / zoom.
export function screenToFlow(viewport, point) {
  return {
    x: (point.x - viewport.x) / viewport.zoom,
    y: (point.y - viewport.y) / viewport.zoom,
  };
}

// Snap the viewport translate to whole pixels. A pan/zoom gesture ends on a
// fractional translate, which blurs glyphs at rest; rounding x/y (zoom untouched)
// lands the surface back on the pixel grid. Returns the SAME object reference when
// already integral, so a caller can use identity to short-circuit a re-snap
// (loop-free, via the equality guard).
export function snapViewport(viewport) {
  const x = Math.round(viewport.x);
  const y = Math.round(viewport.y);
  if (x === viewport.x && y === viewport.y) return viewport;
  return { x, y, zoom: viewport.zoom };
}

// The SVG/CSS transform for the surface group: translate then scale. As an SVG
// matrix this is matrix(zoom, 0, 0, zoom, x, y).
export function viewportMatrix(viewport) {
  return `matrix(${viewport.zoom},0,0,${viewport.zoom},${viewport.x},${viewport.y})`;
}

// Frame a bounding box in the pane: the { x, y, zoom } that centers `bounds` (a flow-
// space {x,y,w,h}) with `padding` reserved as a margin fraction on EACH axis, the zoom
// clamped to [minZoom, maxZoom] (default padding 0.2 / maxZoom 1). `bounds` comes
// from sceneModel.nodesBounds, so the renderer frames off the SAME scene boxes it
// paints. Returns DEFAULT_VIEWPORT when there is nothing to frame or the pane is not
// measured yet.
export function fitViewport(bounds, paneSize, { padding = 0.1, minZoom = 0.2, maxZoom = 1 } = {}) {
  if (!bounds || !paneSize || paneSize.width <= 0 || paneSize.height <= 0) return DEFAULT_VIEWPORT;
  const availW = paneSize.width * (1 - padding * 2);
  const availH = paneSize.height * (1 - padding * 2);
  const w = bounds.w || 1;
  const h = bounds.h || 1;
  const zoom = Math.min(maxZoom, Math.max(minZoom, Math.min(availW / w, availH / h)));
  const cx = bounds.x + bounds.w / 2;
  const cy = bounds.y + bounds.h / 2;
  return { x: paneSize.width / 2 - cx * zoom, y: paneSize.height / 2 - cy * zoom, zoom };
}

// The flow-space rectangle currently visible in a pane of `paneSize` — the two pane
// corners mapped back through screenToFlow. Feeds off-viewport node culling (the
// onlyRenderVisibleElements equivalent) and the minimap's viewport indicator.
export function visibleFlowRect(viewport, paneSize) {
  const tl = screenToFlow(viewport, { x: 0, y: 0 });
  const br = screenToFlow(viewport, { x: paneSize.width, y: paneSize.height });
  return { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y };
}

// Ergonomic factory: a viewport value with the pure helpers bound to it, so the
// renderer / QuickAddMenu can call vp.screenToFlow(point) directly. Returns a new
// value on snap() rather than mutating, matching the rest of the editor model.
export function createViewport(init = DEFAULT_VIEWPORT) {
  const value = { x: init.x ?? 0, y: init.y ?? 0, zoom: init.zoom ?? 1 };
  return {
    ...value,
    screenToFlow: (point) => screenToFlow(value, point),
    flowToScreen: (point) => flowToScreen(value, point),
    matrix: () => viewportMatrix(value),
    snap: () => createViewport(snapViewport(value)),
  };
}
