import { useEffect } from "react";
import { createPortal } from "react-dom";

// Centered confirmation dialog for branch actions (stash & switch, delete,
// force-delete, remote delete). Portal'd to <body> as a real modal instead of a
// cramped bar inside the 256px branch panel — the message gets room and never
// clips. Tagged data-popover="branch-dd" so the global outside-click handler
// treats clicks on it as "inside" the branch popover: button clicks fire (the
// panel isn't torn down on mousedown) and a backdrop click only cancels the
// dialog, leaving the panel open. The backdrop carries no backdrop-filter so
// the dialog's own glass blur isn't nested (WebKit renders nested blur flat).
export function BranchConfirmDialog({ message, confirmLabel, danger, busy, onConfirm, onCancel }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); onCancel(); } };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  return createPortal(
    <div
      className="branch-confirm-backdrop"
      data-popover="branch-dd"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="branch-confirm glass-pop" role="dialog" aria-modal="true">
        <p className="bc-msg">{message}</p>
        <div className="bc-actions">
          <button className="ghost-btn" onClick={onCancel} disabled={busy}>Cancel</button>
          <button
            className={danger ? "bm-danger-btn" : "bm-primary-btn"}
            disabled={busy}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
