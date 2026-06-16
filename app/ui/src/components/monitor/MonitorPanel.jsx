import { MonitorRow } from "./MonitorRow.jsx";

// Expanded panel — reuses the .glass-pop recipe (blur + rim ::after) so the
// liquid-glass look is shared, never re-implemented (DRY). Lists one row per
// live background process across all workers.
export function MonitorPanel({ items, now, onSelect, onClose }) {
  return (
    <div className="mon-panel glass-pop" role="dialog" aria-label="Background activity">
      <div className="mon-panel-head">
        <span className="mon-dot" />
        <span className="mon-title">Background activity</span>
        <span className="mon-head-count">{items.length}</span>
        <button type="button" className="mon-close" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div className="mon-list">
        {items.map((it) => (
          <MonitorRow
            key={it.workerId + ":" + (it.toolUseId ?? it.startedAt)}
            item={it}
            now={now}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  );
}
