import { useCallback, useRef, useState } from "react";
import { computeRects, leaves } from "../../../lib/paneLayout.js";
import { GROUP_COLORS, groupColorHex } from "../../../lib/groupColors.js";
import { useDismiss } from "../../../hooks/useDismiss.js";
import {
  createGroup, switchGroup, renameGroup, setGroupColor, deleteGroup,
} from "../../../state/codeWorkspaceStore.js";
import { PlusGlyph, MoreGlyph } from "../icons.jsx";

// ⌃1..9 reach the first nine groups (CodeView hotkeys).
const HOTKEY_GROUPS = 9;

// The Code sidebar's group switcher: one row per pane group — a live miniature
// of its split layout in the group's color, its name, open-session count and
// ⌃N hotkey. Click switches; ••• (or right-click) opens name / color / delete.
export function GroupList({ ws }) {
  const [menuFor, setMenuFor] = useState(null);
  const closeMenu = useCallback(() => setMenuFor(null), []);

  return (
    <>
      <div className="sb-seclabel">
        <span className="sb-seclabel__text">Groups</span>
        <button className="sb-iconbtn cw-seclabel__act" title="New group" aria-label="New group" onClick={() => createGroup()}>
          <PlusGlyph />
        </button>
      </div>
      <div className="cw-list cw-groups">
        {ws.groups.map((g, i) => (
          <GroupRow
            key={g.id}
            group={g}
            hotkey={i < HOTKEY_GROUPS ? `⌃${i + 1}` : null}
            sessions={leaves(g.tree).filter((l) => ws.terms[l.id]).length}
            active={g.id === ws.activeGroupId}
            menuOpen={menuFor === g.id}
            onMenu={() => setMenuFor(menuFor === g.id ? null : g.id)}
            onCloseMenu={closeMenu}
          />
        ))}
      </div>
    </>
  );
}

function GroupRow({ group, hotkey, sessions, active, menuOpen, onMenu, onCloseMenu }) {
  const cls = ["cw-grp", active ? "on" : "", menuOpen ? "is-menu" : ""].filter(Boolean).join(" ");
  return (
    <div className="cw-grp-wrap" style={{ "--cw-group": groupColorHex(group.color) }}>
      <div className={cls}>
        <button
          className="cw-grp__main"
          onClick={() => switchGroup(group.id)}
          onContextMenu={(e) => { e.preventDefault(); onMenu(); }}
          aria-current={active ? "true" : undefined}
        >
          <GroupThumb tree={group.tree} focusedId={group.focusedId} />
          <span className="cw-grp__name">{group.name}</span>
          {sessions > 0 && <span className="cw-grp__count">{sessions}</span>}
          {hotkey && <span className="cw-grp__key">{hotkey}</span>}
        </button>
        <button
          className="cw-grp__more"
          title="Group options"
          aria-label={`${group.name} options`}
          aria-haspopup="dialog"
          aria-expanded={menuOpen}
          onClick={onMenu}
        >
          <MoreGlyph />
        </button>
      </div>
      {menuOpen && <GroupMenu group={group} sessions={sessions} onClose={onCloseMenu} />}
    </div>
  );
}

// The group's split layout in miniature; the focused pane is solid.
function GroupThumb({ tree, focusedId }) {
  return (
    <span className="cw-grp__thumb" aria-hidden="true">
      {computeRects(tree).map(({ id, rect }) => (
        <span
          key={id}
          className={"cw-grp__cell" + (id === focusedId ? " on" : "")}
          style={{ left: `${rect.left}%`, top: `${rect.top}%`, width: `${rect.width}%`, height: `${rect.height}%` }}
        />
      ))}
    </span>
  );
}

// Rename applies as you type (a blank name is ignored). Deleting a group that
// still runs sessions asks for a second click, since it ends them.
function GroupMenu({ group, sessions, onClose }) {
  const ref = useRef(null);
  const [armed, setArmed] = useState(false);
  useDismiss(ref, onClose);

  const remove = () => {
    if (sessions > 0 && !armed) { setArmed(true); return; }
    deleteGroup(group.id);
    onClose();
  };

  return (
    <div className="cw-menu cw-grp-menu" ref={ref} role="dialog" aria-label={`${group.name} options`}>
      <label className="cw-grp-menu__field">
        <span className="cw-grp-menu__label">Name</span>
        <input
          className="cw-grp-menu__input"
          defaultValue={group.name}
          autoFocus
          onFocus={(e) => e.target.select()}
          onChange={(e) => renameGroup(group.id, e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") onClose(); }}
        />
      </label>
      <span className="cw-grp-menu__label">Color</span>
      <div className="cw-grp-menu__swatches">
        {GROUP_COLORS.map((c) => (
          <button
            key={c.id}
            className={"cw-swatch" + (c.id === group.color ? " on" : "")}
            style={{ "--cw-group": c.hex }}
            title={c.id}
            aria-label={c.id}
            aria-pressed={c.id === group.color}
            onClick={() => setGroupColor(group.id, c.id)}
          />
        ))}
      </div>
      <div className="cw-menu__sep" />
      <button className="cw-menu__item cw-menu__item--action cw-grp-menu__delete" onClick={remove}>
        <span className="cw-menu__name">
          {armed ? `End ${sessions} session${sessions === 1 ? "" : "s"} and delete` : "Delete group"}
        </span>
      </button>
    </div>
  );
}
