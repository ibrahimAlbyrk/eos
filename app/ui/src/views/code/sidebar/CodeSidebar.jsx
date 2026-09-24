import { useUi } from "../../../state/ui.jsx";
import { EosSwitcher } from "../../../components/EosSwitcher.jsx";
import { SettingsFooter } from "../../../components/SettingsFooter.jsx";
import { shortenHome } from "../../../lib/fileUtils.jsx";
import { leaves } from "../../../lib/paneLayout.js";
import {
  KINDS, openTerminal, focusPane, closePane, setCwd,
} from "../../../state/codeWorkspaceStore.js";
import { api } from "../../../api/client.js";
import { useCodeWorkspace } from "../useCodeWorkspace.js";
import { projectFolders } from "../FolderMenu.jsx";
import { folderGroups } from "./folderGroups.js";
import { paneTitle, TERM_PANE_TYPE } from "../TermGrid.jsx";
import { ClaudeGlyph, TerminalGlyph, FolderGlyph, KindGlyph, CloseGlyph } from "../icons.jsx";

function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

function CollapseIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <rect x="2" y="3" width="12" height="10" rx="2" /><line x1="6" y1="3" x2="6" y2="13" />
    </svg>
  );
}

// The Code view's sidebar: new-session actions, then project folders — each
// folder header (click selects it as the workspace folder, + starts Claude Code
// there) above its open sessions (one per pane, draggable onto a pane to
// rearrange the split). Recent folders without a session show as empty groups.
export function CodeSidebar({ live, variant = "full" }) {
  const ui = useUi();
  const ws = useCodeWorkspace();
  const allPanes = leaves(ws.tree);
  const panes = allPanes.filter((l) => ws.terms[l.id]);
  const recents = projectFolders(live.recents);
  const folders = ws.cwd && !recents.includes(ws.cwd) ? [ws.cwd, ...recents] : recents;
  const groups = folderGroups(panes.map((l) => ({ id: l.id, cwd: ws.terms[l.id].cwd, term: ws.terms[l.id] })), folders);

  // Start Claude Code in a folder: it becomes the workspace folder, and the
  // session opens in the focused pane (or a new split beside it).
  const startIn = (path) => {
    setCwd(path);
    openTerminal(KINDS.claude);
  };

  const browse = async () => {
    const r = await api.pickDirectory().catch(() => null);
    if (!r?.path) return;
    setCwd(r.path);
    live.refreshRecents();
  };

  const body = (
    <>
      {variant === "full" && (
        <div className="side-top">
          <span className="side-dot" />
          <span className="side-dot" />
          <span className="side-dot" />
          <button className="side-collapse" title="Collapse panel" onClick={() => ui.collapseSidebar()}>
            <CollapseIcon />
          </button>
        </div>
      )}

      <EosSwitcher />

      <div className="sb-nav">
        <NavRow icon={<ClaudeGlyph />} label="New Claude Code" meta="⌘T" strong onClick={() => openTerminal(KINDS.claude)} />
        <NavRow icon={<TerminalGlyph />} label="New terminal" meta="⇧⌘T" onClick={() => openTerminal(KINDS.shell)} />
        <NavRow icon={<FolderGlyph />} label="Open folder…" onClick={browse} />
      </div>

      <div className="cw-side-scroll">
        {groups.length > 0 && (
          <>
            <div className="sb-seclabel">
              <span className="sb-seclabel__text">Projects</span>
              {panes.length > 0 && <span className="cw-count">{panes.length}</span>}
            </div>
            <div className="cw-list">
              {groups.map((g) => (
                <FolderGroup
                  key={g.key}
                  group={g}
                  current={g.path === ws.cwd}
                  onSelect={() => setCwd(g.path)}
                  onStart={() => startIn(g.path)}
                >
                  {g.roots.map((s) => (
                    <SessionRow
                      key={s.id}
                      leafId={s.id}
                      index={allPanes.findIndex((l) => l.id === s.id)}
                      term={s.term}
                      focused={s.id === ws.focusedId}
                    />
                  ))}
                </FolderGroup>
              ))}
            </div>
          </>
        )}
      </div>

      <SettingsFooter live={live} />
    </>
  );

  if (variant === "popup") return body;
  return <div className="side-island side-island--agents">{body}</div>;
}

function NavRow({ icon, label, meta, strong, selected, onClick }) {
  const cls = ["sb-nav-row", strong ? "strong" : "", selected ? "on" : ""].filter(Boolean).join(" ");
  return (
    <button className={cls} onClick={onClick}>
      <span className="sb-nav-row__ic">{icon}</span>
      <span className="sb-nav-row__label">{label}</span>
      {meta != null && <span className="sb-nav-row__meta">{meta}</span>}
    </button>
  );
}

function SessionRow({ leafId, index, term, focused }) {
  return (
    <div
      className={"cw-row" + (focused ? " on" : "")}
      role="button"
      tabIndex={0}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(TERM_PANE_TYPE, leafId);
        e.dataTransfer.effectAllowed = "move";
      }}
      onClick={() => focusPane(leafId)}
      onKeyDown={(e) => { if (e.key === "Enter") focusPane(leafId); }}
      title={term.cwd}
    >
      <span className="cw-row__ic"><KindGlyph kind={term.kind} size={14} /></span>
      <span className="cw-row__text">
        <span className="cw-row__name">{paneTitle(term)}</span>
      </span>
      <span className="cw-row__meta">⌘{index + 1}</span>
      <button
        className="cw-row__act"
        title="Close session"
        aria-label="Close session"
        onClick={(e) => { e.stopPropagation(); closePane(leafId); }}
      >
        <CloseGlyph />
      </button>
    </div>
  );
}

function FolderGroup({ group, current, onSelect, onStart, children }) {
  const { path, name } = group;
  return (
    <div className="agents-group cw-group">
      <div
        className={"agents-group__head cw-group__head" + (current ? " on" : "")}
        role="button"
        tabIndex={0}
        onClick={path ? onSelect : undefined}
        onDoubleClick={path ? onStart : undefined}
        onKeyDown={(e) => { if (path && e.key === "Enter") onStart(); }}
        title={path ? `${shortenHome(path)}\nDouble-click to start Claude Code here` : undefined}
      >
        <span className="agents-group__icon" aria-hidden="true"><FolderGlyph size={14} /></span>
        <span className="agents-group__name">{name}</span>
        {path && (
          <button
            className="sb-iconbtn agents-group__add"
            title={`New Claude Code in ${name}`}
            aria-label={`New Claude Code in ${name}`}
            onClick={(e) => { e.stopPropagation(); onStart(); }}
          >
            <PlusIcon />
          </button>
        )}
      </div>
      {children}
    </div>
  );
}
