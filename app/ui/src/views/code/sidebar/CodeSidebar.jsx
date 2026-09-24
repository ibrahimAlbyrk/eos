import { useUi } from "../../../state/ui.jsx";
import { EosSwitcher } from "../../../components/EosSwitcher.jsx";
import { SettingsFooter } from "../../../components/SettingsFooter.jsx";
import { basename } from "../../../lib/path.js";
import { shortenHome } from "../../../lib/fileUtils.jsx";
import { leaves } from "../../../lib/paneLayout.js";
import {
  KINDS, openTerminal, focusPane, closePane, setCwd,
} from "../../../state/codeWorkspaceStore.js";
import { api } from "../../../api/client.js";
import { useCodeWorkspace } from "../useCodeWorkspace.js";
import { projectFolders } from "../FolderMenu.jsx";
import { paneTitle, TERM_PANE_TYPE } from "../TermGrid.jsx";
import { ClaudeGlyph, TerminalGlyph, FolderGlyph, KindGlyph, CloseGlyph } from "../icons.jsx";

function CollapseIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <rect x="2" y="3" width="12" height="10" rx="2" /><line x1="6" y1="3" x2="6" y2="13" />
    </svg>
  );
}

// The Code view's sidebar: new-session actions, the open sessions (one per
// pane, in pane order — draggable onto a pane to rearrange the split), and the
// recent folders new sessions start in.
export function CodeSidebar({ live, variant = "full" }) {
  const ui = useUi();
  const ws = useCodeWorkspace();
  const allPanes = leaves(ws.tree);
  const panes = allPanes.filter((l) => ws.terms[l.id]);
  const recents = projectFolders(live.recents);
  const folders = ws.cwd && !recents.includes(ws.cwd) ? [ws.cwd, ...recents] : recents;

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
        {panes.length > 0 && (
          <>
            <div className="sb-seclabel">
              <span className="sb-seclabel__text">Sessions</span>
              <span className="cw-count">{panes.length}</span>
            </div>
            <div className="cw-list">
              {panes.map((l) => (
                <SessionRow
                  key={l.id}
                  leafId={l.id}
                  index={allPanes.indexOf(l)}
                  term={ws.terms[l.id]}
                  focused={l.id === ws.focusedId}
                />
              ))}
            </div>
          </>
        )}

        {folders.length > 0 && (
          <>
            <div className="sb-seclabel cw-seclabel-gap">
              <span className="sb-seclabel__text">Folders</span>
            </div>
            <div className="cw-list">
              {folders.map((p) => (
                <FolderRow
                  key={p}
                  path={p}
                  current={p === ws.cwd}
                  onSelect={() => setCwd(p)}
                  onStart={() => startIn(p)}
                />
              ))}
            </div>
          </>
        )}
      </div>

      <SettingsFooter />
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
        <span className="cw-row__sub">{basename(term.cwd)}</span>
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

function FolderRow({ path, current, onSelect, onStart }) {
  return (
    <div
      className={"cw-row cw-row--folder" + (current ? " on" : "")}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onDoubleClick={onStart}
      onKeyDown={(e) => { if (e.key === "Enter") onStart(); }}
      title={`${path}\nDouble-click to start Claude Code here`}
    >
      <span className="cw-row__ic"><FolderGlyph size={14} /></span>
      <span className="cw-row__text">
        <span className="cw-row__name">{basename(path)}</span>
        <span className="cw-row__sub">{shortenHome(path)}</span>
      </span>
      <button
        className="cw-row__act cw-row__act--go"
        title="Start Claude Code here"
        aria-label="Start Claude Code here"
        onClick={(e) => { e.stopPropagation(); onStart(); }}
      >
        <ClaudeGlyph size={12} />
      </button>
    </div>
  );
}
