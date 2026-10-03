import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useUi } from "../../../state/ui.jsx";
import { SidePanelScopeContext } from "../../../state/paneScope.js";
import { getPanel } from "../../../lib/panelRegistry.js";
import { tabType, filePathOf, pageIdOf } from "../../../lib/panelTabs.js";
import { shortenHome } from "../../../lib/fileUtils.jsx";
import { FileIcon } from "../../files/FileIcon.jsx";
import { closePane as closePtyPane } from "../../../state/ptyPanelStore.js";
import { terminalPaneKey, useTerminalRoot } from "../messages/TerminalViewer.jsx";
import { DELETED, getPage, usePagesVersion } from "../../../state/pagesStore.js";
import { NewTabPanel } from "../../newtab/NewTabPanel.jsx";
import { FileDock } from "./FileDock.jsx";
import { TAB_ICONS, TAB_LABELS } from "./panelTabMeta.jsx";
import "./registerPanels.js";

// A pane's right side panel: a tab bar over a single content area and the file
// dock under it, plus a 6px invisible col-resize handle on its left edge. Rendered INSIDE its pane (scoped
// via PaneScopeContext), so every read/action here resolves to that pane; it
// returns null when that pane's panel is closed. Pills render ONLY the open tabs;
// + opens a new-tab launcher (search, tools, pages, suggested sites) that turns
// into whatever it opens, and an open panel with no tabs shows that launcher.
// A file opened from inside the panel shows in the dock (one opened from
// outside, or pinned, gets its own pill); the active pill's × closes just that
// tab. The panel is shown/hidden by SidePanelToggle, a pane-level overlay pinned
// to the header's top-right, so it stays put while the panel slides open/closed
// under it. Width is that pane's own --sp-w, stored as a fraction of the pane so
// it keeps the same proportion at any window size; double-click the edge resets
// to default.

// Resize bounds within the owning pane: the panel keeps ≥MIN_PANEL_W, the
// transcript column keeps ≥MIN_TX_W.
const MIN_PANEL_W = 280;
const MIN_TX_W = 320;
const DEFAULT_PANEL_FRAC = 0.4;

// The launcher's tools, in order. The Code view passes its own subset (no
// agent-bound tabs).
const AGENT_TABS = ["review", "terminal", "files", "page", "chatfiles", "subagents"];

const baseName = (path) => path.slice(path.lastIndexOf("/") + 1);

// Pill label for a tab id. A file tab shows its file name, a page its title.
// Terminals are numbered ("Terminal 1", "Terminal 2") only when more than one is
// open; a lone one keeps the bare name.
function labelFor(id, openTabs) {
  const filePath = filePathOf(id);
  if (filePath) return baseName(filePath);
  const pageId = pageIdOf(id);
  if (pageId) {
    const page = getPage(pageId);
    if (!page) return "Page";
    return page === DELETED ? "Deleted page" : page.title || "Untitled";
  }
  const type = tabType(id);
  if (type === "newtab") return TAB_LABELS.newtab;
  const base = TAB_LABELS[type] ?? type;
  const sameType = openTabs.filter((t) => tabType(t) === type);
  return sameType.length > 1 ? `${base} ${sameType.indexOf(id) + 1}` : base;
}

function TabPill({ id, label, active, onSelect, onClose }) {
  const filePath = filePathOf(id);
  const icon = filePath ? <FileIcon type="file" name={baseName(filePath)} /> : TAB_ICONS[tabType(id)];
  const title = filePath ? shortenHome(filePath) : undefined;
  // Every pill carries its ×: always shown on the active pill, revealed on hover
  // for inactive ones (CSS-gated) so any open tab is closable. stopPropagation
  // keeps the × from also selecting an inactive pill.
  const closeX = (
    <span
      className="sp-tab-x"
      onClick={(e) => { e.stopPropagation(); onClose(); }}
      title="Close tab"
      role="button"
      aria-label="Close tab"
    >
      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M4 4l8 8M12 4l-8 8" /></svg>
    </span>
  );
  // Middle-click closes the tab, like browser tabs; preventDefault on mousedown
  // suppresses the OS autoscroll cursor.
  const middle = {
    onMouseDown: (e) => { if (e.button === 1) e.preventDefault(); },
    onAuxClick: (e) => { if (e.button === 1) { e.preventDefault(); onClose(); } },
  };
  if (active) {
    return (
      <span className="sp-tab is-active" title={title} {...middle}>
        <span className="sp-tab-icon">{icon}</span>
        <span className="sp-tab-label">{label}</span>
        {closeX}
      </span>
    );
  }
  return (
    <span className="sp-tab" onClick={onSelect} role="button" tabIndex={0} title={title} {...middle}>
      <span className="sp-tab-icon">{icon}</span>
      <span className="sp-tab-label">{label}</span>
      {closeX}
    </span>
  );
}

export function SidePanel({ live, tabs = AGENT_TABS }) {
  const ui = useUi();
  const terminalRoot = useTerminalRoot();
  const openTabs = ui.openTabs ?? [];
  const activeTab = ui.activeTab ?? null;
  const panel = activeTab ? getPanel(tabType(activeTab)) : null;
  const asideRef = useRef(null);
  // Page tab labels are page titles — re-render when one changes.
  usePagesVersion();

  // Width fraction = distance from pointer to the OWNING pane's right edge over
  // the pane width, bounded [MIN_PANEL, pane − MIN_TX] so the transcript column
  // always keeps a usable minimum.
  const fracFor = useCallback((pane, clientX) => {
    const R = pane.getBoundingClientRect();
    return Math.max(MIN_PANEL_W, Math.min(R.right - clientX, R.width - MIN_TX_W)) / R.width;
  }, []);

  const onDragStart = useCallback((e) => {
    if (e.button) return;
    e.preventDefault();
    const pane = asideRef.current?.closest(".pane, .single-pane, .sp-host");
    const aside = asideRef.current;
    if (!pane || !aside) return;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const move = (ev) => { aside.style.setProperty("--sp-w", fracFor(pane, ev.clientX) * 100 + "%"); };
    const up = (ev) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      ui.setSidePanelWidth(fracFor(pane, ev.clientX));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, [fracFor, ui]);

  // Closing a Terminal pill kills its PTY session (one session per top-level tab);
  // other panel types have nothing session-bound to tear down here.
  const closeTabById = (id) => {
    if (tabType(id) === "terminal") {
      closePtyPane(terminalPaneKey(terminalRoot, id));
    }
    ui.closeTab(id);
  };

  // Slide open/closed: `slide` is set on each open↔closed flip (render-time, so
  // the closing panel never unmounts before its animation) and cleared when the
  // animation ends. A panel already open on mount appears without sliding.
  const open = ui.showSidePanel;
  const [wasOpen, setWasOpen] = useState(open);
  const [slide, setSlide] = useState(null);
  if (open !== wasOpen) {
    setWasOpen(open);
    setSlide(open ? "open" : "close");
  }

  // While sliding, the contents hold the final width (right-anchored, clipped by
  // the growing/shrinking panel) so terminals and files don't reflow every frame.
  useLayoutEffect(() => {
    const aside = asideRef.current;
    const pane = aside?.closest(".pane, .single-pane, .sp-host");
    if (!slide || !pane) return;
    const frac = ui.sidePanelWidth || DEFAULT_PANEL_FRAC;
    aside.style.setProperty("--sp-final", frac * pane.clientWidth + "px");
  }, [slide, ui.sidePanelWidth]);

  const toggle = <SidePanelToggle open={open} onToggle={ui.toggleSidePanel} />;

  // All hooks above run every render; only the JSX is gated on open.
  if (!open && slide !== "close") return toggle;

  const fullscreen = ui.panelFullscreen;
  const dock = ui.fileDock;
  const dockOpen = dock.open && dock.history.length > 0;

  return (
    <>
      <aside
        className={"side-panel" + (fullscreen ? " side-panel--fullscreen" : "") + (slide ? ` side-panel--${slide}` : "")}
        ref={asideRef}
        style={{ "--sp-w": (ui.sidePanelWidth || DEFAULT_PANEL_FRAC) * 100 + "%" }}
        onMouseDownCapture={() => ui.setFocusedRegion("panel")}
        onAnimationEnd={(e) => { if (e.target === e.currentTarget) setSlide(null); }}
      >
        <div className="sp-resize" onPointerDown={onDragStart} onDoubleClick={() => ui.setSidePanelWidth(null)} title="Drag to resize" />
        <div className="sp-tabbar">
          {openTabs.map((id) => (
            <TabPill
              key={id}
              id={id}
              label={labelFor(id, openTabs)}
              active={id === activeTab}
              onSelect={() => ui.setTab(id)}
              onClose={() => closeTabById(id)}
            />
          ))}
          <button className="sp-plus" onClick={() => ui.openNewTab("newtab")} title="New tab" aria-label="New tab">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M8 3v10M3 8h10" /></svg>
          </button>
          <span className="sp-spacer" />
          <span className={"sp-chrome-btn" + (fullscreen ? " on" : "")} onClick={ui.toggleFullscreen} title={fullscreen ? "Exit fullscreen" : "Fullscreen"} role="button">
            {fullscreen ? (
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M13 3 9 7V3M9 7h4M3 13l4-4v4M7 9H3" /></svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 3h4v4M7 13H3V9M8 8l5-5M8 8l-5 5" /></svg>
            )}
          </span>
        </div>
        <SidePanelScopeContext.Provider value={true}>
          <div className={"sp-body" + (panel && dockOpen && dock.max ? " sp-body--dock-max" : "")}>
            {(panel || !dockOpen) && (
              <div className="sp-content">
                {panel
                  ? <panel.Component key={activeTab} live={live} tabId={activeTab} tools={tabs} />
                  : <NewTabPanel live={live} tools={tabs} />}
              </div>
            )}
            {dockOpen && <FileDock live={live} fill={!panel} />}
          </div>
        </SidePanelScopeContext.Provider>
      </aside>
      {toggle}
    </>
  );
}

// Open/close button pinned over the pane's top-right corner, exactly where the
// header reserves its slot — it never moves; open = lit fill + filled-rail icon.
function SidePanelToggle({ open, onToggle }) {
  const label = open ? "Close side panel" : "Open side panel";
  return (
    <button
      className={"pane-split-btn sp-toggle" + (open ? " is-active" : "")}
      title={label}
      aria-label={label}
      aria-pressed={open}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
        {open && <path d="M10.5 3H12a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-1.5z" fill="currentColor" stroke="none" />}
        <rect x="2" y="3" width="12" height="10" rx="2" />
        <line x1="10.5" y1="3" x2="10.5" y2="13" />
      </svg>
    </button>
  );
}
