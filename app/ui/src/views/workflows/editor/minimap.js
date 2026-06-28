// Pure minimap projection for the bespoke renderer — fits a content bounds rect into
// a fixed minimap panel (`size` px, `pad` inset), preserving aspect ratio and
// centering, and exposes the forward/inverse maps between flow coords and minimap-
// local px. The overview node boxes, the viewport indicator, and the click/drag-to-
// navigate hit-test all share THIS one transform, so they never drift apart. No
// React/DOM imports → unit-tests in the repo's node env beside viewport.test.js.

// The union of two flow-space {x,y,w,h} rects (either may be null). Used to widen the
// minimap's content bounds to also cover the current viewport, so the indicator
// rectangle stays visible even when the pan has left the nodes off to one side.
export function unionRect(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

// Build the projection for `bounds` into a `size` panel. `scale` is the single
// (aspect-preserving) flow→mini ratio; `toMini`/`fromMini` are the inverse pair.
export function minimapProjection(bounds, size, pad = 6) {
  const safe = bounds && bounds.w > 0 && bounds.h > 0 ? bounds : { x: 0, y: 0, w: 1, h: 1 };
  const innerW = Math.max(1, size.width - pad * 2);
  const innerH = Math.max(1, size.height - pad * 2);
  const scale = Math.min(innerW / safe.w, innerH / safe.h);
  // Center the scaled content inside the padded panel.
  const offsetX = pad + (innerW - safe.w * scale) / 2 - safe.x * scale;
  const offsetY = pad + (innerH - safe.h * scale) / 2 - safe.y * scale;
  return {
    scale,
    offsetX,
    offsetY,
    toMini: (p) => ({ x: p.x * scale + offsetX, y: p.y * scale + offsetY }),
    fromMini: (p) => ({ x: (p.x - offsetX) / scale, y: (p.y - offsetY) / scale }),
  };
}
