import { createPortal } from "react-dom";

// Cursor-tracking drag affordance: a neutral glass label trailing the pointer +
// an accent pill snapped to the target region's centroid. Presentational — it
// depends only on { pointer, zone } (pointer carries the cursor position and the
// hovered pane's live rect). Portaled to <body> so it escapes the panes'
// overflow:clip. Deliberately SEPARATE from DropPreview (which lives inside the
// pane and frosts its content): different stacking context, different concern.

const LABEL_OFFSET = 16; // trail the cursor down-right so it doesn't sit under it
const EDGE_MARGIN = 8; // keep the pill off the very viewport edge

// Centroid (viewport px) of the region the drop targets: the matching half for an
// edge split, the pane center for a replace. Derived from the pane's live rect
// (not an assumed size) so deep/odd-aspect splits still anchor correctly.
function regionCentroid(rect, zone) {
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  if (zone.kind !== "split") return { x: cx, y: cy };
  switch (zone.edge) {
    case "left": return { x: rect.left + rect.width / 4, y: cy };
    case "right": return { x: rect.left + rect.width * 0.75, y: cy };
    case "top": return { x: cx, y: rect.top + rect.height / 4 };
    case "bottom": return { x: cx, y: rect.top + rect.height * 0.75 };
    default: return { x: cx, y: cy };
  }
}

const clamp = (v, max) => Math.max(EDGE_MARGIN, Math.min(max - EDGE_MARGIN, v));

export function DragAffordance({ pointer, zone }) {
  if (!pointer || !zone) return null;
  const c = regionCentroid(pointer.rect, zone);
  const px = clamp(c.x, window.innerWidth);
  const py = clamp(c.y, window.innerHeight);
  return createPortal(
    <>
      <div
        className="drag-affordance-pill"
        style={{ transform: `translate(${px}px, ${py}px) translate(-50%, -50%)` }}
      >
        {zone.kind === "split" ? "Add split" : "Open here"}
      </div>
      <div
        className="drag-affordance-label"
        style={{ transform: `translate(${pointer.x + LABEL_OFFSET}px, ${pointer.y + LABEL_OFFSET}px)` }}
      >
        Open in split
      </div>
    </>,
    document.body,
  );
}
