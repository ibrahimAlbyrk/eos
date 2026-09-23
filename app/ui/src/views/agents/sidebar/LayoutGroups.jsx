import { useState } from "react";
import { createPortal } from "react-dom";
import { useUi } from "../../../state/ui.jsx";
import { fillAgents, leaves, leafCount } from "../../../lib/paneLayout.js";
import {
  useLayoutGroups, addGroup, updateGroup, renameGroup, deleteGroup, setActiveGroup,
} from "../../../state/layoutGroupsStore.js";
import { NewGroupModal } from "../popovers/NewGroupModal.jsx";

function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

// Structural equality ignoring the (always-fresh) node ids. A leaf whose saved
// agent has since died and now restores empty is NOT a divergence — that empty
// pane is the deliberate dead-agent-preserve outcome, so treat cur=null vs a
// dead saved agent as equal (else every restore with a dead agent reads dirty).
function sameLayout(cur, saved, aliveIds) {
  if (!cur || !saved || cur.t !== saved.t) return false;
  if (cur.t === "leaf") {
    const c = cur.agentId ?? null;
    const s = saved.agentId ?? null;
    if (c === s) return true;
    return c === null && s !== null && !aliveIds.has(s);
  }
  return cur.dir === saved.dir
    && Math.round(cur.ratio * 100) === Math.round(saved.ratio * 100)
    && sameLayout(cur.a, saved.a, aliveIds)
    && sameLayout(cur.b, saved.b, aliveIds);
}

export function LayoutGroups({ aliveIds }) {
  const ui = useUi();
  const { groups, activeGroupId } = useLayoutGroups();
  const [creating, setCreating] = useState(false);
  const [renameFor, setRenameFor] = useState(null); // group being renamed | null
  const [menu, setMenu] = useState(null); // { id, x, y } | null

  const activeGroup = groups.find((g) => g.id === activeGroupId) ?? null;
  const dirty = activeGroup ? !sameLayout(ui.tree, activeGroup.tree, aliveIds) : false;

  // Restore a saved layout: clone its structure with fresh leaf ids and re-home
  // each pane's own agent — a saved agent that's no longer alive restores as an
  // empty pane (null) so the split shape is preserved. leaves() DFS order matches
  // fillAgents' fill order, so each resolved agent lands back in its own leaf.
  const applyGroup = (g) => {
    const resolved = leaves(g.tree).map((l) => (l.agentId != null && aliveIds.has(l.agentId) ? l.agentId : null));
    ui.setLayout(fillAgents(g.tree, resolved));
    setActiveGroup(g.id);
  };

  const openMenu = (e, id) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ id, x: e.clientX, y: e.clientY });
  };

  const menuGroup = menu ? groups.find((g) => g.id === menu.id) ?? null : null;

  return (
    <div className="layout-groups">
      <div className="agents-group">
        <div className="agents-group__head">
          <span className="agents-group__name">Layouts</span>
          <button
            className="sb-iconbtn agents-group__add"
            title="Save current layout as group"
            onClick={() => setCreating(true)}
          >
            <PlusIcon />
          </button>
        </div>
        {groups.map((g) => (
          <div
            key={g.id}
            className={`agents-row${g.id === activeGroupId ? " on" : ""}`}
            onClick={() => applyGroup(g)}
            onContextMenu={(e) => openMenu(e, g.id)}
            title={g.name}
          >
            <span className="ag-name">{g.name}</span>
            {g.id === activeGroupId && dirty && <span className="lg-dirty" title="Unsaved changes"></span>}
            <span className="ag-status">{leafCount(g.tree)}</span>
          </div>
        ))}
      </div>

      {menu && menuGroup && createPortal(
        <>
          <div className="lg-menu-backdrop" onMouseDown={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }}></div>
          <div
            className="ctx-menu glass-pop open"
            data-popover="ctx-menu"
            style={{
              display: "block",
              left: Math.min(menu.x, window.innerWidth - 190),
              top: Math.min(menu.y, window.innerHeight - 150),
            }}
          >
            <button className="menu-item" onClick={() => { setRenameFor(menuGroup); setMenu(null); }}>Rename</button>
            <button className="menu-item" onClick={() => { updateGroup(menuGroup.id, ui.tree); setActiveGroup(menuGroup.id); setMenu(null); }}>Update to current</button>
            <div className="menu-sep"></div>
            <button className="menu-item danger" onClick={() => { deleteGroup(menuGroup.id); setMenu(null); }}>Delete</button>
          </div>
        </>,
        document.body,
      )}

      {creating && (
        <NewGroupModal
          title="Save layout"
          onSave={(name) => { const id = addGroup(name, ui.tree); if (id) setActiveGroup(id); setCreating(false); }}
          onCancel={() => setCreating(false)}
        />
      )}
      {renameFor && (
        <NewGroupModal
          title="Rename layout"
          initialName={renameFor.name}
          onSave={(name) => { renameGroup(renameFor.id, name); setRenameFor(null); }}
          onCancel={() => setRenameFor(null)}
        />
      )}
    </div>
  );
}
