import { useUi } from "../../../state/ui.jsx";

// Hover preview for a collapsed-paste pill in the composer. Anchored above the
// input on the same plane as SlashInfoPopover; ui.popoverPos.x = pill offset
// within .c-row2-wrap, set by the composer's hover delegation. The card is
// itself hoverable (read/scroll it) — the composer passes enter/leave handlers
// that hold the close timer open while the pointer is on it.
export function PasteInfoPopover({ onMouseEnter, onMouseLeave }) {
  const ui = useUi();
  if (ui.openPopover !== "pasteinfo") return null;
  const { preview, lines } = ui.popoverData ?? {};
  if (preview == null) return null;

  return (
    <div
      className="paste-info glass-pop open"
      data-popover="pasteinfo"
      role="dialog"
      aria-label="Pasted text preview"
      style={{ left: ui.popoverPos.x }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="paste-info-head">{lines} lines</div>
      <pre className="paste-info-body">{preview}</pre>
    </div>
  );
}
