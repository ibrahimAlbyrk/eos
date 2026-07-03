import { useMemo, useSyncExternalStore } from "react";
import { useUi } from "../../state/ui.jsx";
import { fmtTimeAgo } from "../../lib/format.js";
import { nameOf } from "../../lib/agentName.js";
import { archivedTree } from "../../lib/archive.js";
import { subscribe, getArchive, selectArchived } from "../../state/archiveStore.js";

// Archived-agents tree section — rendered by CodeSidebar in place of the agent
// tree while archive mode is on. Subtree ROOTS are the top-level rows; an
// archived orchestrator expands to reveal its archived workers with the same
// chevron + ui.collapsedNodes mechanism as the live tree. Children are
// select-only (their transcripts open in ArchiveView) — restore/purge act on
// the whole subtree, so the context menu stays on roots. Data + selection live
// in archiveStore so the full sidebar and the collapsed-hover popup stay in
// sync; ArchiveView owns the refetch cadence. Right-click on a root opens the
// archive context menu (ArchiveContextMenu, mounted by CodeView).
export function ArchiveSidebar() {
  const { rows, loaded, selectedId } = useSyncExternalStore(subscribe, getArchive);
  const roots = useMemo(() => archivedTree(rows), [rows]);

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
          <ArchiveNode key={w.id} node={w} selectedId={selectedId} isRoot />
        ))}
      </div>
    </>
  );
}

function ArchiveNode({ node, selectedId, isRoot = false }) {
  const ui = useUi();
  // Archived subtrees start COLLAPSED (inverse of the live tree): membership in
  // the shared collapse store means "user expanded this archived node", so an
  // untouched orchestrator hides its workers until its chevron is clicked.
  const collapsed = !ui.collapsedNodes.has(node.id);
  const hasChildren = node.children.length > 0;

  const onCtx = (e) => {
    e.preventDefault();
    if (isRoot) ui.openPop("archive-ctx", { x: e.clientX, y: e.clientY, data: { agentId: node.id } });
  };

  return (
    <div className={`tree-node${collapsed ? " collapsed" : ""}`}>
      <div
        className={`agents-row${selectedId === node.id ? " on" : ""}`}
        onClick={() => selectArchived(node.id)}
        onContextMenu={onCtx}
      >
        {hasChildren ? (
          <button
            className="tree-chev"
            title="Toggle"
            onClick={(e) => { e.stopPropagation(); ui.toggleNodeCollapsed(node.id); }}
          >
            <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="m4 6 4 4 4-4" />
            </svg>
          </button>
        ) : (
          <span className="tree-chev-spacer"></span>
        )}
        <span className="ag-dot wait"></span>
        <span className={`ag-name ${node.is_orchestrator ? "main" : ""}`}>{nameOf(node)}</span>
        <span className="ag-status">{node.archived_at ? fmtTimeAgo(node.archived_at) : ""}</span>
      </div>
      {hasChildren && (
        <div className="tree-children">
          {node.children.map((c) => (
            <ArchiveNode key={c.id} node={c} selectedId={selectedId} />
          ))}
        </div>
      )}
    </div>
  );
}
