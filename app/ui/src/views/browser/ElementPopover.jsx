// ElementPopover — the picker's hover card (plan §4 Phase 7). A floating
// glass-pop (same treatment as the composer's slash/paste popovers) that reads
// off ONE BrowserElement: the tag, its pixel dimensions, and an accessibility
// block (Name / Role / Keyboard-focusable). Presentational only — position and
// element come from PickerLayer.

const POP_W = 220;
const POP_H = 150;
const GAP = 14; // offset the card off the cursor so it never sits under the pointer

export function ElementPopover({ element, x, y, bounds }) {
  const dims = `${Math.round(element.box[2])} × ${Math.round(element.box[3])}`;
  // Clamp inside the surface so an element near the right/bottom edge keeps the
  // card on screen (Infinity when bounds is absent → no clamp, e.g. in tests).
  const maxLeft = (bounds?.width ?? Infinity) - POP_W - 4;
  const maxTop = (bounds?.height ?? Infinity) - POP_H - 4;
  const left = Math.max(4, Math.min(x + GAP, maxLeft));
  const top = Math.max(4, Math.min(y + GAP, maxTop));

  return (
    <div className="picker-popover glass-pop open" role="dialog" aria-label="Element info" style={{ left, top }}>
      <div className="picker-pop-head">
        <span className="picker-pop-tag">{element.tag}</span>
        <span className="picker-pop-dims">{dims}</span>
      </div>
      <div className="picker-pop-a11y">
        <div className="picker-pop-a11y-title">Accessibility</div>
        <dl className="picker-pop-rows">
          <div className="picker-pop-row"><dt>Name</dt><dd>{element.name || "—"}</dd></div>
          <div className="picker-pop-row"><dt>Role</dt><dd>{element.role || "—"}</dd></div>
          <div className="picker-pop-row"><dt>Keyboard-focusable</dt><dd>{element.focusable ? "Yes" : "No"}</dd></div>
        </dl>
      </div>
    </div>
  );
}
