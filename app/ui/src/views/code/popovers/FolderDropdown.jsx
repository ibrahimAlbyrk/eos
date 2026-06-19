import { useEffect, useState } from "react";
import { useUi } from "../../../state/ui.jsx";
import { api } from "../../../api/client.js";
import { basename } from "../../../lib/path.js";
import { SearchField } from "./SearchField.jsx";

export function FolderDropdown({ live }) {
  const ui = useUi();
  const [query, setQuery] = useState("");
  const open = ui.openPopover === "folder-dd";

  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  if (!open) return null;

  const current = ui.composer.cwd;
  const setCwd = (path) => ui.updateComposer({ cwd: path });

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

  const q = query.trim().toLowerCase();
  const recents = q ? live.recents.filter((p) => p.toLowerCase().includes(q)) : live.recents;
  const hasRecents = live.recents.length > 0;

  return (
    <div className="cb-chip-dd open" id="cbFolderDD" data-popover="folder-dd">
      <div className="cb-chip-dd-scroll">
        <div className="sp-chip-dd-head">Recent</div>
        {recents.length === 0 && (
          <div style={{ padding: "10px 12px", color: "var(--fg-faint)", fontSize: "var(--text-sm)" }}>
            {hasRecents ? "No matching folders" : "No recent folders yet"}
          </div>
        )}
        {recents.map((p) => (
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
      </div>

      {hasRecents && (
        <SearchField value={query} onChange={setQuery} placeholder="Search folders…" />
      )}

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
