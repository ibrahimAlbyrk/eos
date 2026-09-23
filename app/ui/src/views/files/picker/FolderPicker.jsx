import { createPortal } from "react-dom";
import { useUi } from "../../../state/ui.jsx";
import { api } from "../../../api/client.js";
import { explorer, useExplorerRoot } from "../../../state/explorerStore.js";
import { baseName } from "../../../lib/explorerApi.js";
import { CheckIcon } from "../../../lib/gitIconKit.jsx";
import { FolderGlyph } from "../../code/icons.jsx";
import { projectFolders } from "../../code/FolderMenu.jsx";

const MAX_RECENTS = 5;

// Root switcher. Portal'd to <body> — the panel lives inside a contain:paint
// pane that would clip the fixed overlay. Reuses the header Split menu recipe
// (.split-menu rows); position comes from the toolbar chip via popover state.
export function FolderPicker({ live, agentDir }) {
  const ui = useUi();
  const root = useExplorerRoot();
  if (ui.openPopover !== "fx-folder") return null;
  const { x, y } = ui.popoverPos;

  const choose = (path) => { ui.closeAllPops(); explorer.setRoot(path); };
  const openNative = async () => {
    ui.closeAllPops();
    const r = await api.pickDirectory().catch(() => null);
    if (r?.path) { explorer.setRoot(r.path); live?.refreshRecents?.(); }
  };

  const recents = projectFolders(live?.recents)
    .filter((p) => p !== root && p !== agentDir)
    .slice(0, MAX_RECENTS);

  return createPortal(
    <div className="split-menu fx-picker" data-popover="fx-folder" style={{ left: Math.min(x, window.innerWidth - 280), top: y }}>
      {agentDir && (
        <button className="menu-item" onClick={() => choose(agentDir)} title={agentDir}>
          <FolderGlyph size={14} />
          <span className="sm-label">Current agent’s folder</span>
          <span className={"sm-check" + (root === agentDir ? " on" : "")}><CheckIcon /></span>
        </button>
      )}
      <button className="menu-item" onClick={openNative}>
        <OpenIcon />
        <span className="sm-label">Open folder…</span>
        <span className="kbd">⌘O</span>
      </button>
      {recents.length > 0 && <div className="sm-sec">Recent</div>}
      {recents.map((p) => (
        <button key={p} className="menu-item" onClick={() => choose(p)} title={p}>
          <FolderGlyph size={14} />
          <span className="sm-label">{baseName(p)}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}

function OpenIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5M12 9.5V13a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V4.5A.5.5 0 0 1 3 4h3.5" />
    </svg>
  );
}
