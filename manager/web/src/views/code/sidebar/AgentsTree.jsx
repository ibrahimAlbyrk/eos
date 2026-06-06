import { useCallback, useEffect, useRef, useState } from "react";
import { useUi } from "../../../state/ui.jsx";
import { statusFromState } from "../../../lib/format.js";

function nameOf(w) {
  return w.name || (w.is_orchestrator ? "Orchestrator" : w.id);
}

export function AgentsTree({ roots, onRename }) {
  if (roots.length === 0) {
    return (
      <div className="agents-section">
        <div className="empty-tree" style={{ padding: "24px 14px", color: "var(--fg-faint)", fontSize: "var(--text-sm)" }}>
          No agents yet — click + to spawn an orchestrator
        </div>
      </div>
    );
  }
  return (
    <div className="agents-section">
      {roots.map((n) => (
        <TreeNode key={n.id} node={n} onRename={onRename} />
      ))}
    </div>
  );
}

function RenameInput({ currentName, onSave, onCancel }) {
  const [value, setValue] = useState(currentName);
  const inputRef = useRef(null);
  const valueRef = useRef(value);
  const doneRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const commit = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    const trimmed = valueRef.current.trim();
    if (trimmed && trimmed !== currentName) onSave(trimmed);
    else onCancel();
  }, [currentName, onSave, onCancel]);

  return (
    <input
      ref={inputRef}
      className="ag-rename-input"
      value={value}
      onChange={(e) => { setValue(e.target.value); valueRef.current = e.target.value; }}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        if (e.key === "Escape") { e.preventDefault(); onCancel(); }
        e.stopPropagation();
      }}
      onBlur={commit}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

function TreeNode({ node, onRename }) {
  const ui = useUi();
  const collapsed = ui.collapsedNodes.has(node.id);
  const hasChildren = node.children.length > 0;
  const status = statusFromState(node.state);
  const cls = ["tree-node"];
  if (collapsed) cls.push("collapsed");
  const isSelected = ui.selectedId === node.id;
  const rowCls = ["agents-row"];
  if (isSelected) rowCls.push("on");
  const isRenaming = ui.renamingId === node.id;

  const onClick = () => ui.setSelectedId(node.id);
  const onCtx = (e) => {
    e.preventDefault();
    ui.openPop("ctx-menu", {
      x: e.clientX, y: e.clientY,
      data: { agentId: node.id },
    });
  };

  const handleRename = useCallback((newName) => {
    ui.setRenamingId(null);
    onRename?.(node.id, newName);
  }, [node.id, onRename, ui]);

  const cancelRename = useCallback(() => {
    ui.setRenamingId(null);
  }, [ui]);

  return (
    <div className={cls.join(" ")}>
      <div className={rowCls.join(" ")} onClick={onClick} onContextMenu={onCtx}>
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
        <span className={`ag-dot ${status.dot}`}></span>
        {node.agent_role === "git" && !isRenaming && (
          <span className="ag-git-badge" title="Git agent">
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="4.5" cy="3.5" r="1.5" />
              <circle cx="4.5" cy="12.5" r="1.5" />
              <circle cx="11.5" cy="5" r="1.5" />
              <path d="M4.5 5v6M11.5 6.5c0 2.2-2.7 2.6-4.5 3.2" />
            </svg>
          </span>
        )}
        {isRenaming
          ? <RenameInput currentName={nameOf(node)} onSave={handleRename} onCancel={cancelRename} />
          : <span
              className={`ag-name ${node.is_orchestrator ? "main" : ""}`}
              onDoubleClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                ui.setRenamingId(node.id);
              }}
            >{nameOf(node)}</span>}
        {!isRenaming && (ui.hasNewActivity(node)
          ? <span className="ag-notify" aria-label="new activity" title="new activity"></span>
          : <span className="ag-status">{status.label}</span>)}
      </div>
      {hasChildren && (
        <div className="tree-children">
          {node.children.map((c) => (
            <TreeNode key={c.id} node={c} onRename={onRename} />
          ))}
        </div>
      )}
    </div>
  );
}
