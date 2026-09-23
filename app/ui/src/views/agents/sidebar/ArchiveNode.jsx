import { useUi } from "../../../state/ui.jsx";
import { fmtTimeAgo } from "../../../lib/format.js";
import { nameOf } from "../../../lib/agentName.js";
import { selectArchived } from "../../../state/archiveStore.js";

// An archived agent row, rendered inline in the unified sidebar list (AgentsTree)
// alongside live TreeNode rows. It keeps its own selection path (selectArchived
// → opens the archived transcript) and context menu (archive-ctx), plus a
// distinct archive-tray icon and dimmed styling (.agents-row--archived) so it
// reads as archived even when interleaved with active rows under a shared group.
// Archived subtrees start COLLAPSED (inverse of the live tree): membership in the
// shared collapse store means "user expanded this archived node".

// The app's archive glyph (a tray/box), matching the Archive action's icon —
// replaces the earlier trash can so an archived row isn't mistaken for deletion.
function ArchiveTrayIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="12" height="3.5" rx="1" />
      <path d="M3.5 6.5V12a1.5 1.5 0 0 0 1.5 1.5h6A1.5 1.5 0 0 0 12.5 12V6.5M6.5 9.5h3" />
    </svg>
  );
}

export function ArchiveNode({ node, selectedId, isRoot = false }) {
  const ui = useUi();
  const collapsed = !ui.collapsedNodes.has(node.id);
  const hasChildren = node.children.length > 0;

  const onCtx = (e) => {
    e.preventDefault();
    if (isRoot) ui.openPop("archive-ctx", { x: e.clientX, y: e.clientY, data: { agentId: node.id } });
  };

  return (
    <div className={`tree-node${collapsed ? " collapsed" : ""}`}>
      <div
        className={`agents-row agents-row--archived${selectedId === node.id ? " on" : ""}`}
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
        <span className="ag-archive-icon"><ArchiveTrayIcon /></span>
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
