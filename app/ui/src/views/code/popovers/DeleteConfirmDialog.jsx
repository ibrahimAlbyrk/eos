import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

// Agent permanent-delete confirmation, in the settings panel's design
// language: the overlay/surface mirror .stg-overlay/.stg-modal and the
// "don't ask again" row reuses the stg-row/stg-toggle classes verbatim
// (see .del-confirm in styles.css). The tick stays local state — the caller
// persists it (confirm.agentDelete) only when the delete is confirmed, so
// cancelling never silently disables future confirmations.
export function DeleteConfirmDialog({ title = "Delete agent", message, busy, onConfirm, onCancel }) {
  const [dontAskAgain, setDontAskAgain] = useState(false);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); onCancel(); } };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  return createPortal(
    <div
      className="del-confirm-overlay"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="del-confirm glass-pop" role="dialog" aria-modal="true">
        <div className="del-confirm__body">
          <h2 className="stg-title">{title}</h2>
          <p className="del-confirm__msg">{message}</p>
          <div className="stg-row">
            <div className="stg-row__text">
              <div className="stg-row__label">Don't ask again</div>
              <div className="stg-row__desc">Delete immediately from now on. Reversible in Settings → General.</div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={dontAskAgain}
              aria-label="Don't ask again"
              className={`stg-toggle${dontAskAgain ? " is-on" : ""}`}
              onClick={() => setDontAskAgain((v) => !v)}
            >
              <span className="stg-toggle__knob" />
            </button>
          </div>
          <div className="del-confirm__actions">
            <button className="del-confirm__cancel" onClick={onCancel} disabled={busy}>Cancel</button>
            <button className="del-confirm__danger" disabled={busy} onClick={() => onConfirm(dontAskAgain)}>
              Delete permanently
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
