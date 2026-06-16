import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

// Right-click menu for a branch row. Portal'd to <body> so its glass isn't
// nested inside the branch panel's glass (WebKit renders nested backdrop-filter
// flat) — and tagged data-popover="branch-dd" so the global outside-click
// handler treats clicks on it as "inside" the branch popover and keeps the
// panel open. Closes itself on outside click / Escape.
//
// `items` is a list of { label, icon?, kbd?, danger?, onClick } or the string
// "sep" for a divider.
export function BranchContextMenu({ x, y, items, onClose }) {
  const ref = useRef(null);

  useEffect(() => {
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  const rows = items.filter(Boolean);
  const left = Math.min(x, window.innerWidth - 200);
  const top = Math.min(y, window.innerHeight - (rows.length * 32 + 16));

  return createPortal(
    <div
      ref={ref}
      className="ctx-menu glass-pop open branch-ctx"
      data-popover="branch-dd"
      style={{ display: "block", left, top }}
    >
      {rows.map((it, i) =>
        it === "sep" ? (
          <div key={`sep-${i}`} className="menu-sep" />
        ) : (
          <button
            key={it.label}
            className={"menu-item" + (it.danger ? " danger" : "")}
            onClick={() => { onClose(); it.onClick(); }}
          >
            {it.icon}
            <span>{it.label}</span>
            {it.kbd && <span className="kbd">{it.kbd}</span>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
