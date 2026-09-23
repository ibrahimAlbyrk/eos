import { useState } from "react";

// Update banner — the dedicated server has a newer build. "Update" applies
// now (full `eos build` → the running app relaunches itself once the rebuilt
// daemon is up); "Later" hides it for this daemon session. The
// reopen-updates path is handled natively by the launch splash, not here —
// this is purely the in-app affordance for a running session.
export function UpdateBanner({ update, onApply, onDefer }) {
  const [applying, setApplying] = useState(false);
  if (!update?.available || update.deferred) return null;

  const behind = update.behind ?? 0;
  const notes = (update.notes ?? []).slice(0, 3);

  const apply = async () => {
    if (applying) return;
    setApplying(true);
    const r = await onApply();
    // Success ⇒ the app relaunches shortly once the rebuilt daemon is up; keep
    // the pending state. Refused ⇒ release it so the user can retry / dismiss.
    if (r?.started === false) setApplying(false);
  };

  return (
    <div className="update-banner">
      <div className="update-card">
        <div className="update-header">
          <span className="update-dot" />
          <span className="update-title">
            {applying ? "Updating…" : "New update ready"}
          </span>
          <span className="update-count">
            {behind} commit{behind === 1 ? "" : "s"}
          </span>
        </div>
        {notes.length > 0 && !applying && (
          <ul className="update-notes">
            {notes.map((n) => (
              <li key={n.sha}>
                <code>{n.sha}</code> {n.subject}
              </li>
            ))}
          </ul>
        )}
        <div className="update-actions">
          <button className="update-btn update-later" onClick={onDefer} disabled={applying}>
            Later
          </button>
          <button className="update-btn update-now" onClick={apply} disabled={applying}>
            {applying ? "Updating…" : "Update"}
          </button>
        </div>
      </div>
    </div>
  );
}
