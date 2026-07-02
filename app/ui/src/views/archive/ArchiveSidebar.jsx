import { useMemo, useSyncExternalStore } from "react";
import { useUi } from "../../state/ui.jsx";
import { fmtTimeAgo } from "../../lib/format.js";
import { nameOf } from "../../lib/agentName.js";
import { archivedRoots } from "../../lib/archive.js";
import { subscribe, getArchive, selectArchived } from "../../state/archiveStore.js";

// Archived-agents list section — rendered by CodeSidebar in place of the agent
// tree while archive mode is on. Subtree ROOTS only (restore/purge act on the
// whole subtree, so children never get their own rows). Data + selection live
// in archiveStore so the full sidebar and the collapsed-hover popup stay in
// sync; ArchiveView owns the refetch cadence. Right-click opens the archive
// context menu (ArchiveContextMenu, mounted by CodeView).
export function ArchiveSidebar() {
  const ui = useUi();
  const { rows, loaded, selectedId } = useSyncExternalStore(subscribe, getArchive);
  const roots = useMemo(() => archivedRoots(rows), [rows]);

  const onCtx = (e, id) => {
    e.preventDefault();
    ui.openPop("archive-ctx", { x: e.clientX, y: e.clientY, data: { agentId: id } });
  };

  return (
    <>
      <div className="sb-head">
        <div className="sb-head__title">
          Archive {roots.length > 0 && <span className="sb-head__count">{roots.length}</span>}
        </div>
      </div>
      <div className="agents-section">
        {roots.length === 0 ? (
          <div className="empty-tree" style={{ padding: "24px 14px", color: "var(--fg-faint)", fontSize: "var(--text-sm)" }}>
            {loaded ? "No archived agents — Cmd+W archives the selected one" : "Loading…"}
          </div>
        ) : roots.map((w) => (
          <div
            key={w.id}
            className={`agents-row${selectedId === w.id ? " on" : ""}`}
            onClick={() => selectArchived(w.id)}
            onContextMenu={(e) => onCtx(e, w.id)}
          >
            <span className="ag-dot wait"></span>
            <span className={`ag-name ${w.is_orchestrator ? "main" : ""}`}>{nameOf(w)}</span>
            <span className="ag-status">{w.archived_at ? fmtTimeAgo(w.archived_at) : ""}</span>
          </div>
        ))}
      </div>
    </>
  );
}
