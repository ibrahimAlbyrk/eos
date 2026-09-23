import { useEffect, useRef } from "react";
import { api } from "../../api/client.js";
import { basename } from "../../lib/path.js";
import { shortenHome } from "../../lib/fileUtils.jsx";
import { FolderGlyph } from "./icons.jsx";

// Recent folders minus Eos-internal dirs (worktrees, old session folders).
export function projectFolders(recents) {
  return (recents ?? []).filter((p) => !p.includes("/.eos/"));
}

// Folder chooser popover: recent folders + the native "Open folder…" picker.
// Rendered by its trigger's wrapper (position: relative); closes on outside
// click / Escape.
export function FolderMenu({ live, current, onPick, onClose }) {
  const ref = useRef(null);

  useEffect(() => {
    const onDown = (e) => { if (!ref.current?.parentElement?.contains(e.target)) onClose(); };
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [onClose]);

  const pick = (path) => { onPick(path); onClose(); };

  const browse = async () => {
    const r = await api.pickDirectory().catch(() => null);
    if (r?.path) {
      onPick(r.path);
      live.refreshRecents();
    }
    onClose();
  };

  const recents = projectFolders(live.recents);

  return (
    <div className="cw-menu" ref={ref} role="menu">
      <div className="cw-menu__head">Recent folders</div>
      <div className="cw-menu__list">
        {recents.length === 0 && <div className="cw-menu__empty">No recent folders yet</div>}
        {recents.map((p) => (
          <button
            key={p}
            className={"cw-menu__item" + (p === current ? " on" : "")}
            onClick={() => pick(p)}
            title={p}
            role="menuitemradio"
            aria-checked={p === current}
          >
            <span className="cw-menu__name">{basename(p)}</span>
            <span className="cw-menu__path">{shortenHome(p)}</span>
          </button>
        ))}
      </div>
      <div className="cw-menu__sep" />
      <button className="cw-menu__item cw-menu__item--action" onClick={browse}>
        <FolderGlyph size={13} />
        <span className="cw-menu__name">Open folder…</span>
      </button>
    </div>
  );
}
