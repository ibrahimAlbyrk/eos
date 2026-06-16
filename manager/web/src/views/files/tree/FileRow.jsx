import { memo } from "react";
import { FileIcon } from "../FileIcon.jsx";
import { RenameInput } from "../../../components/RenameInput.jsx";

// One tree row. memo'd on primitive props so a selection/expand change only
// re-renders the rows that actually changed (handlers from FileTree are stable).
// Non-entry kinds (loading/empty/error) render a muted marker at the right indent.
export const FileRow = memo(function FileRow({
  node, selected, anchor, expanded, dirty, renaming, dropTarget,
  onClick, onContext, onToggle, onDragStart, onDragOver, onDragLeave, onDrop, onRename, onRenameCancel,
}) {
  const pad = 8 + node.depth * 14;

  if (node.kind !== "entry") {
    const label = node.kind === "loading" ? "Loading…" : node.kind === "error" ? "Failed to load" : "Empty";
    return <div className="fx-row fx-row--marker" style={{ paddingLeft: pad + 19 }}>{label}</div>;
  }

  const isDir = node.type === "directory";
  const cls = ["fx-row"];
  if (selected) cls.push("on");
  if (anchor) cls.push("anchor");
  if (dropTarget) cls.push("fx-row--drop");
  if (isDir && expanded) cls.push("fx-expanded");

  return (
    <div
      className={cls.join(" ")}
      style={{ paddingLeft: pad }}
      data-fx-path={node.path}
      draggable={!renaming}
      onClick={(e) => onClick(node.path, e)}
      onContextMenu={(e) => onContext(node.path, e)}
      onDragStart={(e) => onDragStart(node.path, e)}
      onDragOver={isDir ? (e) => onDragOver(node.path, e) : undefined}
      onDragLeave={isDir ? () => onDragLeave(node.path) : undefined}
      onDrop={isDir ? (e) => onDrop(node.path, e) : undefined}
    >
      {isDir ? (
        <button className="tree-chev" onClick={(e) => { e.stopPropagation(); onToggle(node.path); }} tabIndex={-1} aria-label="Toggle">
          <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="m6 4 4 4-4 4" />
          </svg>
        </button>
      ) : (
        <span className="tree-chev-spacer" />
      )}
      <span className="fx-ic"><FileIcon type={node.type} name={node.name} expanded={expanded} /></span>
      {renaming ? (
        <RenameInput currentName={node.name} onSave={(n) => onRename(node.path, n)} onCancel={onRenameCancel} />
      ) : (
        <span className="fx-name">{node.name}{node.isSymlink && <span className="fx-symlink" title="Symlink"> ↪</span>}</span>
      )}
      {dirty && <span className="fx-row__dirty" title="Unsaved changes" />}
    </div>
  );
});
