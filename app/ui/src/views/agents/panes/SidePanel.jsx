import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useUi } from "../../../state/ui.jsx";
import { getPanel } from "../../../lib/panelRegistry.js";
import { tabType, filePathOf } from "../../../lib/panelTabs.js";
import { shortenHome } from "../../../lib/fileUtils.jsx";
import { FileIcon } from "../../files/FileIcon.jsx";
import { closePane as closePtyPane } from "../../../state/ptyPanelStore.js";
import { terminalPaneKey, useTerminalRoot } from "../messages/TerminalViewer.jsx";
import "./registerPanels.js";

// A pane's right side panel: a tab bar over a single content area, plus a 6px
// invisible col-resize handle on its left edge. Rendered INSIDE its pane (scoped
// via PaneScopeContext), so every read/action here resolves to that pane; it
// returns null when that pane's panel is closed. Pills render ONLY the open tabs
// (default: none — a quiet empty state); the + menu opens Terminal / Files / Chat
// files (every opened file gets its own pill), the active pill's × closes just that tab. The
// panel is shown/hidden by SidePanelToggle, a pane-level overlay pinned to the
// header's top-right, so it stays put while the panel slides open/closed under
// it. Width is that pane's own --sp-w; double-click the edge resets to default.

const ICONS = {
  review: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3"><rect x="2.5" y="2.5" width="11" height="11" rx="2" /><path d="M5.5 8h5M8 5.5v5" /></svg>,
  files: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M2 4.4a1 1 0 0 1 1-1h2.8l1.3 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.4Z" /></svg>,
  terminal: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" /><path d="M4 6l2.5 2L4 10" /><line x1="8" y1="10.5" x2="11" y2="10.5" /></svg>,
  browser: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3"><circle cx="8" cy="8" r="6" /><ellipse cx="8" cy="8" rx="2.6" ry="6" /><path d="M2.4 6h11.2M2.4 10h11.2" /></svg>,
  chatfiles: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d="M10.5 4.5 5.8 9.2a1.5 1.5 0 0 0 2.1 2.1l5-5a3 3 0 0 0-4.2-4.2l-5 5a4.5 4.5 0 0 0 6.4 6.4L13 10.6" /></svg>,
};

// Resize bounds within the owning pane: the panel keeps ≥MIN_PANEL_W, the
// transcript column keeps ≥MIN_TX_W.
const MIN_PANEL_W = 280;
const MIN_TX_W = 320;

// Tab labels for every openable panel type. Pills render only the currently
// open tabs (ui.openTabs), in the order they were opened.
const TAB_LABELS = {
  review: "Review",
  files: "Files",
  terminal: "Terminal",
  browser: "Browser",
  chatfiles: "Chat files",
};

// + menu entries, in order. The Code view passes its own subset (no agent-bound
// tabs); menu shortcut hints per type.
const AGENT_TABS = ["terminal", "files", "browser", "chatfiles"];
const TAB_KBD = { terminal: "⌃`", files: "⌘P" };

const baseName = (path) => path.slice(path.lastIndexOf("/") + 1);

// Pill label for a tab id. A file tab shows its file name. Multi-instance types are numbered ("Terminal 1",
// "Terminal 2") only when more than one is open; a lone one keeps the bare name.
function labelFor(id, openTabs) {
  const filePath = filePathOf(id);
  if (filePath) return baseName(filePath);
  const type = tabType(id);
  const base = TAB_LABELS[type] ?? type;
  const sameType = openTabs.filter((t) => tabType(t) === type);
  return sameType.length > 1 ? `${base} ${sameType.indexOf(id) + 1}` : base;
}

function TabPill({ id, label, active, onSelect, onClose }) {
  const filePath = filePathOf(id);
  const icon = filePath ? <FileIcon type="file" name={baseName(filePath)} /> : ICONS[tabType(id)];
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

function PlusMenu({ tabs, onPick }) {
  return (
    <div className="sp-plus-menu" data-pop="sidepanel-plus">
      {tabs.map((type) => (
        <div key={type} className="sp-plus-item" onClick={(e) => { e.stopPropagation(); onPick(type); }}>
          <span className="sp-tab-icon">{ICONS[type]}</span>
          <span className="sp-plus-label">{TAB_LABELS[type]}</span>
          {TAB_KBD[type] && <span className="sp-plus-kbd">{TAB_KBD[type]}</span>}
        </div>
      ))}
    </div>
  );
}

// Quiet resting state when the panel is open with no tabs (the last one was
// closed, or a fresh session). Points at the + menu, the way tabs are opened.
function EmptyPanel() {
  return (
    <div className="empty-state">
      <span className="empty-state__icon">
        <svg width="40" height="40" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="12" height="10" rx="2" /><line x1="10.5" y1="3" x2="10.5" y2="13" /></svg>
      </span>
      <span className="empty-state__title">No panel open</span>
      <span className="empty-state__subtitle">Open a tab from the + menu.</span>
    </div>
  );
}

export function SidePanel({ live, tabs = AGENT_TABS }) {
  const ui = useUi();
  const terminalRoot = useTerminalRoot();
  const openTabs = ui.openTabs ?? [];
  const activeTab = ui.activeTab ?? null;
  const panel = activeTab ? getPanel(tabType(activeTab)) : null;
  const asideRef = useRef(null);
  const [plusOpen, setPlusOpen] = useState(false);

  // Close the + menu on any outside pointerdown.
  useEffect(() => {
    if (!plusOpen) return;
    const onDown = (e) => {
      if (!e.target.closest?.(".sp-plus-menu") && !e.target.closest?.(".sp-plus")) setPlusOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [plusOpen]);

  // Clamp helper shared by drag + fullscreen: width = distance from pointer to
  // the OWNING pane's right edge, bounded [MIN_PANEL, pane − MIN_TX] so the
  // transcript column always keeps a usable minimum.
  const clampFor = useCallback((pane, clientX) => {
    const R = pane.getBoundingClientRect();
    return Math.round(Math.max(MIN_PANEL_W, Math.min(R.right - clientX, R.width - MIN_TX_W)));
  }, []);

  const onDragStart = useCallback((e) => {
    if (e.button) return;
    e.preventDefault();
    const pane = asideRef.current?.closest(".pane, .single-pane, .sp-host");
    const aside = asideRef.current;
    if (!pane || !aside) return;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const move = (ev) => { aside.style.setProperty("--sp-w", clampFor(pane, ev.clientX) + "px"); };
    const up = (ev) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      ui.setSidePanelWidth(clampFor(pane, ev.clientX));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, [clampFor, ui]);

  const pickTab = (t) => { ui.openNewTab(t); setPlusOpen(false); };

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
    const w = ui.sidePanelWidth || Math.min(620, pane.clientWidth / 2);
    aside.style.setProperty("--sp-final", w + "px");
  }, [slide, ui.sidePanelWidth]);

  const toggle = <SidePanelToggle open={open} onToggle={ui.toggleSidePanel} />;

  // All hooks above run every render; only the JSX is gated on open.
  if (!open && slide !== "close") return toggle;

  const fullscreen = ui.panelFullscreen;

  return (
    <>
      <aside
        className={"side-panel" + (fullscreen ? " side-panel--fullscreen" : "") + (slide ? ` side-panel--${slide}` : "")}
        ref={asideRef}
        style={{ "--sp-w": ui.sidePanelWidth ? ui.sidePanelWidth + "px" : "min(620px, 50%)" }}
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
          <span className={"sp-plus" + (plusOpen ? " on" : "")} onClick={() => setPlusOpen((v) => !v)} title="New tab" role="button">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M8 3v10M3 8h10" /></svg>
            {plusOpen && <PlusMenu tabs={tabs} onPick={pickTab} />}
          </span>
          <span className="sp-spacer" />
          <span className={"sp-chrome-btn" + (fullscreen ? " on" : "")} onClick={ui.toggleFullscreen} title={fullscreen ? "Exit fullscreen" : "Fullscreen"} role="button">
            {fullscreen ? (
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M13 3 9 7V3M9 7h4M3 13l4-4v4M7 9H3" /></svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 3h4v4M7 13H3V9M8 8l5-5M8 8l-5 5" /></svg>
            )}
          </span>
        </div>
        <div className="sp-content">
          {panel ? <panel.Component key={activeTab} live={live} tabId={activeTab} /> : <EmptyPanel />}
        </div>
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
