import { useCallback, useEffect, useRef, useState } from "react";
import { useUi } from "../../state/ui.jsx";
import { statusFromState } from "../../lib/format.js";

function nameOf(w) {
  return w.name || (w.is_orchestrator ? "Orchestrator" : w.id);
}

function matches(w, q) {
  if (!q) return true;
  const ql = q.toLowerCase();
  return nameOf(w).toLowerCase().includes(ql) || String(w.model ?? "").toLowerCase().includes(ql);
}

function visibleNodes(tree, q) {
  // Show a node if it or any descendant matches the filter.
  const out = [];
  for (const root of tree) {
    const r = filterClone(root, q);
    if (r) out.push(r);
  }
  return out;
}

function filterClone(node, q) {
  const kids = node.children
    .map((c) => filterClone(c, q))
    .filter(Boolean);
  if (matches(node, q) || kids.length) {
    return { ...node, children: kids };
  }
  return null;
}

export function AgentsTree({ roots, filter, onRename }) {
  const visible = visibleNodes(roots, filter);
  if (visible.length === 0) {
    return (
      <div className="agents-section">
        <div className="empty-tree" style={{ padding: "24px 14px", color: "var(--fg-faint)", fontSize: 12 }}>
          {filter ? "No agents match" : "No agents yet — click + to spawn an orchestrator"}
        </div>
      </div>
    );
  }
  return (
    <div className="agents-section">
      {visible.map((n) => (
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
      data: { agentId: node.id, name: nameOf(node), model: node.model },
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
        {isRenaming
          ? <RenameInput currentName={nameOf(node)} onSave={handleRename} onCancel={cancelRename} />
          : <span className={`ag-name ${node.is_orchestrator ? "main" : ""}`}>{nameOf(node)}</span>}
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
