import { useEffect, useState, useCallback } from "react";
import { useUi } from "../../../state/ui.jsx";
import { api } from "../../../api/client.js";
import { shortenHome } from "../../../lib/fileUtils.jsx";

// Right-panel viewer over a project's Claude file-based memory
// (~/.claude/projects/<encoded-cwd>/memory), resolved per-worker to its project
// root by the daemon. Clicking a memory opens it in the FileViewer (read it
// there, edit-and-save there if wanted); each row has a remove button. No
// in-panel form — the panel is a clean list.

export function MemoryViewer() {
  const ui = useUi();
  const open = !!ui.memoryViewer;
  return (
    <div className={"memory-viewer" + (ui.topPanelType === "memory" ? " mv-open" : "")}>
      {open && <MemoryViewerInner workerId={ui.memoryViewer.workerId} />}
    </div>
  );
}

function MemoryViewerInner({ workerId }) {
  const ui = useUi();
  const [dir, setDir] = useState(null);
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState(null);

  const reload = useCallback(() => {
    return api.listMemory(workerId)
      .then((data) => { setDir(data.dir); setEntries(data.entries); setError(null); })
      .catch((e) => setError(e.message));
  }, [workerId]);

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setDir(null);
    setError(null);
    api.listMemory(workerId)
      .then((data) => { if (!cancelled) { setDir(data.dir); setEntries(data.entries); } })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [workerId]);

  return (
    <>
      <div className="fv-row1">
        <span className="fv-title">Memory</span>
        <button className="fv-icon-btn fv-close" onClick={ui.closeMemoryViewer} title="Close">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="m4 4 8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>
      {dir && (
        <div className="fv-row2">
          <span className="fv-path">{shortenHome(dir)}</span>
        </div>
      )}
      <div className="mv-body">
        {error && <div className="mv-error">{error}</div>}
        {entries === null && !error && <div className="mv-state">Loading…</div>}
        {entries && entries.length === 0 && !error && (
          <div className="mv-empty">
            <div className="mv-empty-title">No memories yet</div>
            <div className="mv-empty-sub">This project has no saved Claude memory.</div>
          </div>
        )}
        {entries && entries.length > 0 && (
          <div className="mv-list">
            {entries.map((e) => (
              <MemoryRow
                key={e.name}
                entry={e}
                workerId={workerId}
                onOpen={() => ui.openFileViewer(e.path)}
                onDeleted={reload}
                onError={setError}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function MemoryRow({ entry, workerId, onOpen, onDeleted, onError }) {
  const [confirming, setConfirming] = useState(false);

  const remove = async () => {
    const r = await api.deleteMemory(workerId, entry.name);
    if (!r.ok) { onError(r.body?.error || `remove failed (${r.status})`); return; }
    onDeleted();
  };

  return (
    <div className={"mv-item" + (confirming ? " mv-item-danger" : "")}>
      <button className="mv-item-open" onClick={onOpen} title="View">
        <span className="mv-name-row">
          <span className="mv-name">{entry.name}</span>
          <span className="mv-type">{entry.type}</span>
        </span>
        {entry.description && <span className="mv-desc">{entry.description}</span>}
      </button>
      {confirming ? (
        <div className="mv-row-confirm">
          <button className="mv-confirm-yes" onClick={remove}>Remove</button>
          <button className="mv-confirm-no" onClick={() => setConfirming(false)}>Cancel</button>
        </div>
      ) : (
        <button className="mv-icon-btn mv-trash" onClick={() => setConfirming(true)} title="Remove">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 4.5h10M6.5 4.5V3h3v1.5M5 4.5l.5 8.5h5l.5-8.5" />
          </svg>
        </button>
      )}
    </div>
  );
}
