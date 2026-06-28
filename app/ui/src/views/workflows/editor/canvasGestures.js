// Pure gesture math for the bespoke SVG renderer's interaction layer — the
// testable geometry the pointer handlers lean on, kept free of React/DOM so it
// unit-tests in the repo's node env beside viewport.test.js / sceneModel.test.js.
//
// Two families: zoom-at-cursor (wheel-zoom that keeps the flow point under the
// pointer fixed, the way React Flow's d3-zoom anchors a wheel gesture) and
// marquee selection (axis-aligned box intersection over the scene's node boxes,
// mirroring RF's SelectionMode.Partial — a node is selected when the box merely
// overlaps it, not only when fully enclosed).

import { screenToFlow } from "./viewport.js";

// Canvas zoom bounds (minZoom 0.2 / maxZoom 2.5).
export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 2.5;

export function clampZoom(zoom, min = MIN_ZOOM, max = MAX_ZOOM) {
  return Math.min(max, Math.max(min, zoom));
}

// Zoom by a multiplicative `factor` while pinning the flow coordinate currently
// under `panePoint` (PANE-LOCAL screen px) in place — so the point beneath the
// cursor does not drift. Derivation: the flow point f = (pane - t)/z must satisfy
// pane = f*z' + t' after zooming, so t' = pane - f*z'. Returns a new viewport.
export function zoomAtPoint(viewport, panePoint, factor, { min = MIN_ZOOM, max = MAX_ZOOM } = {}) {
  const zoom = clampZoom(viewport.zoom * factor, min, max);
  const f = screenToFlow(viewport, panePoint);
  return {
    x: panePoint.x - f.x * zoom,
    y: panePoint.y - f.y * zoom,
    zoom,
  };
}

// A wheel delta → zoom factor. Trackpad/mouse wheels report deltaY; up (negative)
// zooms in. The exponential keeps each notch a constant *ratio* (so zoom feels
// even across the range), matching d3-zoom's wheel handling.
export function wheelZoomFactor(deltaY, sensitivity = 0.0015) {
  return Math.exp(-deltaY * sensitivity);
}

// Normalize two corner points into an {x,y,w,h} rect with non-negative size, so a
// marquee dragged in any direction yields a well-formed box.
export function normalizeRect(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

// Axis-aligned overlap test between two {x,y,w,h} rects (edge-touching counts as
// disjoint, matching a strict marquee).
export function rectsIntersect(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

// Snap a coordinate to the nearest grid line (RF's snapToGrid). Applied to a node's
// committed position when the snap toggle is on, so dropped nodes land on the dot grid.
export function snapToGrid(value, grid) {
  return Math.round(value / grid) * grid;
}

// Scene node ids whose box intersects the marquee rect (all in flow coords) —
// partial-overlap selection, like RF's SelectionMode.Partial. `nodes` are scene
// nodes ({ id, box:{x,y,w,h} }).
export function nodesInMarquee(nodes, rectFlow) {
  return (nodes || []).filter((n) => n.box && rectsIntersect(n.box, rectFlow)).map((n) => n.id);
}

// The edges to paint given an in-flight reconnect: the edge whose endpoint is being
// dragged is dropped so ONLY the live rubber-band preview shows, matching React Flow
// (which unmounts the edge while reconnecting — `!reconnecting && <Edge>`). Without
// it the stale wire and the preview would both draw during the drag. `reconnectEdgeId`
// is null for a plain pan/new-connect, so every edge renders.
export function edgesForDisplay(edges, reconnectEdgeId) {
  if (!reconnectEdgeId) return edges || [];
  return (edges || []).filter((e) => e.id !== reconnectEdgeId);
}
