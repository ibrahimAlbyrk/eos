import { useUi } from "../../state/ui.jsx";
import { api } from "../../api/client.js";
import { basename } from "../../lib/path.js";

export function FolderDropdown({ live }) {
  const ui = useUi();
  if (ui.openPopover !== "folder-dd") return null;

  const draft = ui.drafts.get(ui.selectedId);
  const current = (draft ?? ui.composer).cwd;
  const setCwd = (path) => {
    if (draft) ui.updateDraft(ui.selectedId, { cwd: path });
    else ui.updateComposer({ cwd: path });
  };

  const pick = (path) => {
    setCwd(path);
    ui.closeAllPops();
  };

  const openPicker = async () => {
    const r = await api.pickDirectory();
    if (r?.path) {
      setCwd(r.path);
      await live.refreshRecents();
    }
    ui.closeAllPops();
  };

  return (
    <div className="cb-chip-dd open" id="cbFolderDD" data-popover="folder-dd">
      <div className="sp-chip-dd-head">Recent</div>
      {live.recents.length === 0 && (
        <div style={{ padding: "10px 12px", color: "var(--fg-faint)", fontSize: 12 }}>
          No recent folders yet
        </div>
      )}
      {live.recents.map((p) => (
        <button
          key={p}
          className={"sp-chip-dd-item" + (current === p ? " on" : "")}
          onClick={() => pick(p)}
          title={p}
        >
          <span>{basename(p)}</span>
          <span className="check">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="m4 8 3 3 5-6" />
            </svg>
          </span>
        </button>
      ))}
      <div className="sp-chip-dd-sep"></div>
      <button className="sp-chip-dd-item sp-chip-dd-item--action" onClick={openPicker}>
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M2 5a1 1 0 0 1 1-1h3l2 2h5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5z" />
        </svg>
        <span>Open folder…</span>
      </button>
    </div>
  );
}
