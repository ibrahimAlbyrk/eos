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

export function AgentsTree({ roots, filter }) {
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
        <TreeNode key={n.id} node={n} />
      ))}
    </div>
  );
}

function TreeNode({ node }) {
  const ui = useUi();
  const collapsed = ui.collapsedNodes.has(node.id);
  const hasChildren = node.children.length > 0;
  const status = statusFromState(node.state);
  const cls = ["tree-node"];
  if (collapsed) cls.push("collapsed");
  const isSelected = ui.selectedId === node.id;
  const rowCls = ["agents-row"];
  if (isSelected) rowCls.push("on");

  const onClick = () => ui.setSelectedId(node.id);
  const onCtx = (e) => {
    e.preventDefault();
    ui.openPop("ctx-menu", {
      x: e.clientX, y: e.clientY,
      data: { agentId: node.id, name: nameOf(node), model: node.model },
    });
  };

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
        <span className={`ag-name ${node.is_orchestrator ? "main" : ""}`}>{nameOf(node)}</span>
        {ui.hasNewActivity(node)
          ? <span className="ag-notify" aria-label="new activity" title="new activity"></span>
          : <span className="ag-status">{status.label}</span>}
      </div>
      {hasChildren && (
        <div className="tree-children">
          {node.children.map((c) => (
            <TreeNode key={c.id} node={c} />
          ))}
        </div>
      )}
    </div>
  );
}
