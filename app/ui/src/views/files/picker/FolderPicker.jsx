import { createPortal } from "react-dom";
import { useUi } from "../../../state/ui.jsx";
import { api } from "../../../api/client.js";
import { explorer } from "../../../state/explorerStore.js";
import { baseName } from "../../../lib/explorerApi.js";
import { shortenHome } from "../../../lib/fileUtils.jsx";

// Root switcher. Portal'd to <body> — the panel lives inside a contain:paint
// pane that would clip the fixed overlay, and a backdrop-filter nested inside
// another backdrop-filtered element renders flat in WebKit (same reason
// MenuList's flyout is a sibling). Position comes from the toolbar chip via
// the popover state.
export function FolderPicker({ live }) {
  const ui = useUi();
  if (ui.openPopover !== "fx-folder") return null;
  const { x, y } = ui.popoverPos;
  const width = ui.popoverData?.width ?? 252;

  const choose = (path) => { ui.closeAllPops(); explorer.setRoot(path); };
  const openNative = async () => {
    ui.closeAllPops();
    const r = await api.pickDirectory();
    if (r?.path) { explorer.setRoot(r.path); live.refreshRecents?.(); }
  };

  const agent = live.workers.find((w) => w.id === ui.selectedId);
  const recents = live.recents?.paths ?? [];
  const left = Math.min(x, window.innerWidth - width - 8);

  return createPortal(
    <div className="fx-picker glass-pop open" data-popover="fx-folder" style={{ left, top: y, width }}>
      {agent?.cwd && (
        <button className="fx-picker-item" onClick={() => choose(agent.cwd)}>
          <span className="fx-picker-name">Current agent’s folder</span>
          <span className="fx-picker-sub">{shortenHome(agent.cwd)}</span>
        </button>
      )}
      <button className="fx-picker-item" onClick={openNative}>
        <span className="fx-picker-name">Open folder…</span>
      </button>
      {recents.length > 0 && <div className="fx-picker-label">Recent</div>}
      {recents.map((p) => (
        <button key={p} className="fx-picker-item" onClick={() => choose(p)}>
          <span className="fx-picker-name">{baseName(p)}</span>
          <span className="fx-picker-sub">{shortenHome(p)}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}
