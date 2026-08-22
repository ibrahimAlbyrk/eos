import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useUi } from "../../../state/ui.jsx";
import { useSidebarPrefs, setPref } from "../../../state/sidebarPrefsStore.js";
import { setArchiveViewing } from "../../../state/archiveStore.js";

// The sidebar settings popover: Group by / Sort by / Status, each a parent row
// with a right flyout carrying a checkmark on the active option. Opened from the
// sliders button in SidebarHead (ui.openPop("sidebar-prefs", {x,y})); positioned
// fixed at the click like the other ctx menus. Reads/writes sidebarPrefsStore.
//
// The flyout is PORTALED to <body> (a DOM sibling of the panel), not nested
// inside it: WebKit drops backdrop-filter on a blurred element nested in another
// blurred one, so a nested flyout would lose the .glass-pop frost. As a body
// sibling it gets the real frosted-glass surface. It carries the same
// data-popover so the outside-click plumbing treats it as part of the menu.

const SECTIONS = [
  { key: "groupBy", label: "Group by", options: [["folder", "Folder"], ["date", "Date"], ["custom", "Custom"]] },
  { key: "sortBy", label: "Sort by", options: [["alpha", "Alphabetically"], ["created", "Created time"], ["recency", "Recency"]] },
  { key: "status", label: "Status", options: [["all", "All"], ["active", "Active"], ["archived", "Archived"]] },
];

function CheckMark() {
  return (
    <svg className="pr-menu-check" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="m3 8 3 3 7-7" />
    </svg>
  );
}

export function SidebarPrefsMenu() {
  const ui = useUi();
  const prefs = useSidebarPrefs();
  const [sub, setSub] = useState(null); // { key, rect } of the open flyout's parent row
  const isOpen = ui.openPopover === "sidebar-prefs";

  useEffect(() => { if (!isOpen) setSub(null); }, [isOpen]);
  if (!isOpen) return null;

  const { x, y } = ui.popoverPos;
  const left = Math.min(x, window.innerWidth - 240);
  const top = Math.min(y, window.innerHeight - 200);

  const openSub = (key, el) => setSub({ key, rect: el.getBoundingClientRect() });

  const pick = (key, value) => {
    setPref(key, value);
    // Status drives the main-area archive view: archived → on, else off.
    if (key === "status") setArchiveViewing(value === "archived");
    ui.closeAllPops();
  };

  const subSection = sub ? SECTIONS.find((s) => s.key === sub.key) : null;

  return (
    <>
      <div
        className="ctx-menu glass-pop open sb-prefs-menu"
        data-popover="sidebar-prefs"
        style={{ display: "block", left, top }}
      >
        {SECTIONS.map((s) => {
          const activeLabel = s.options.find(([v]) => v === prefs[s.key])?.[1] ?? "";
          return (
            <button
              key={s.key}
              className={`menu-item${sub?.key === s.key ? " active" : ""}`}
              onMouseEnter={(e) => openSub(s.key, e.currentTarget)}
              onClick={(e) => (sub?.key === s.key ? setSub(null) : openSub(s.key, e.currentTarget))}
            >
              <span className="sb-prefs-label">{s.label}</span>
              <span className="sb-prefs-val">{activeLabel}</span>
              <svg className="sub-chev" width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
                <path d="m6 4 4 4-4 4" />
              </svg>
            </button>
          );
        })}
      </div>
      {subSection && createPortal(
        <div
          className="ctx-menu glass-pop open sb-prefs-flyout"
          data-popover="sidebar-prefs"
          style={{
            display: "block",
            left: Math.min(sub.rect.right + 4, window.innerWidth - 190),
            top: Math.min(sub.rect.top - 4, window.innerHeight - 170),
          }}
        >
          {subSection.options.map(([value, label]) => (
            <button
              key={value}
              className={`menu-item${prefs[subSection.key] === value ? " on" : ""}`}
              onClick={() => pick(subSection.key, value)}
            >
              {label}
              {prefs[subSection.key] === value && <CheckMark />}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
