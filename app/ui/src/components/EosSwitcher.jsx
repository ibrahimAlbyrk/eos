import { useEffect, useRef, useState } from "react";
import { useNavigation, useSearch } from "../state/ui.jsx";
import { TABS } from "../views/tabs.js";

// The sidebar's top workspace switcher, shared by the Agents and Code sidebars:
// the active view's name ("Agents ▾" / "Code ▾") whose click opens the view menu, plus a search icon (⌘K / command palette) at the row's right.
function ChevronDown() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="m4 6 4 4 4-4" />
    </svg>
  );
}

function Check() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m3 8 3 3 7-7" />
    </svg>
  );
}

export function EosSwitcher() {
  const { activeViewId, setActiveView } = useNavigation();
  const { openSearch } = useSearch();
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (!rootRef.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const pick = (id) => { setActiveView(id); setOpen(false); };
  const active = TABS.find((t) => t.id === activeViewId) ?? TABS[0];

  return (
    <div className="side-eos">
      <div
        ref={rootRef}
        className={"eos-switch" + (open ? " on" : "")}
        onClick={() => setOpen((v) => !v)}
        role="button"
        tabIndex={0}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="eos-switch__mark">{active.label}</span>
        <span className="eos-switch__chev"><ChevronDown /></span>
        {open && (
          <div className="eos-menu" role="menu">
            {TABS.map((t) => (
              <div
                key={t.id}
                className="eos-menu__item"
                role="menuitemradio"
                aria-checked={activeViewId === t.id}
                onClick={(e) => { e.stopPropagation(); pick(t.id); }}
              >
                <span className="eos-menu__ic"><t.Icon /></span>
                <span>{t.label}</span>
                <span className={"eos-menu__check" + (activeViewId === t.id ? " on" : "")}><Check /></span>
              </div>
            ))}
          </div>
        )}
      </div>
      <span className="side-eos__spacer" />
      <button className="eos-search" title="Search (⌘K)" aria-label="Search" onClick={() => openSearch()}>
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
          <circle cx="7" cy="7" r="5" />
          <path d="m13 13-2.5-2.5" />
        </svg>
      </button>
    </div>
  );
}
