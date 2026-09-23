import { useCallback, useEffect, useRef, useState } from "react";
import { useUi } from "../../../state/ui.jsx";
import { getPanel } from "../../../lib/panelRegistry.js";
import "./registerPanels.js";

// The ONE shared right side panel: a tab bar over a single content area, plus a
// 6px invisible col-resize handle on its left edge. It is a grid sibling of the
// pane area (AppLayout column 3), keyed to the selected agent, not per pane.
// Pills render ONLY the open tabs (default: none — a quiet empty state); the +
// menu opens Terminal / Files / Chat files, the active pill's × closes just that
// tab, and the chrome × hides the whole panel. Width persists
// (cm:sidePanelWidth); double-click the edge resets to min(620px, 40vw).

const ICONS = {
  review: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3"><rect x="2.5" y="2.5" width="11" height="11" rx="2" /><path d="M5.5 8h5M8 5.5v5" /></svg>,
  files: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M2 4.4a1 1 0 0 1 1-1h2.8l1.3 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.4Z" /></svg>,
  terminal: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" /><path d="M4 6l2.5 2L4 10" /><line x1="8" y1="10.5" x2="11" y2="10.5" /></svg>,
  browser: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3"><circle cx="8" cy="8" r="6" /><ellipse cx="8" cy="8" rx="2.6" ry="6" /><path d="M2.4 6h11.2M2.4 10h11.2" /></svg>,
  chatfiles: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d="M10.5 4.5 5.8 9.2a1.5 1.5 0 0 0 2.1 2.1l5-5a3 3 0 0 0-4.2-4.2l-5 5a4.5 4.5 0 0 0 6.4 6.4L13 10.6" /></svg>,
};

// Tab labels for every openable panel type. Pills render only the currently
// open tabs (ui.openTabs), in the order they were opened.
const TAB_LABELS = {
  review: "Review",
  files: "Files",
  terminal: "Terminal",
  browser: "Browser",
  chatfiles: "Chat files",
};

function TabPill({ type, label, active, onSelect, onClose }) {
  if (active) {
    return (
      <span className="sp-tab is-active">
        <span className="sp-tab-icon">{ICONS[type]}</span>
        <span className="sp-tab-label">{label}</span>
        <span className="sp-tab-x" onClick={onClose} title="Close tab" role="button" aria-label="Close tab">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M4 4l8 8M12 4l-8 8" /></svg>
        </span>
      </span>
    );
  }
  return (
    <span className="sp-tab" onClick={onSelect} role="button" tabIndex={0}>
      <span className="sp-tab-icon">{ICONS[type]}</span>
      <span className="sp-tab-label">{label}</span>
    </span>
  );
}

function PlusMenu({ onPick }) {
  const item = (type, label, kbd) => (
    <div className="sp-plus-item" onClick={() => onPick(type)}>
      <span className="sp-tab-icon">{ICONS[type]}</span>
      <span className="sp-plus-label">{label}</span>
      {kbd && <span className="sp-plus-kbd">{kbd}</span>}
    </div>
  );
  return (
    <div className="sp-plus-menu" data-pop="sidepanel-plus">
      {item("terminal", "Terminal", "⌃`")}
      {item("files", "Files", "⌘P")}
      {item("chatfiles", "Chat files")}
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
      <span className="empty-state__subtitle">Open Terminal, Files or Chat files from the + menu.</span>
    </div>
  );
}

export function SidePanel({ live }) {
  const ui = useUi();
  const openTabs = ui.openTabs ?? [];
  const activeTab = ui.activeTab ?? null;
  const panel = activeTab ? getPanel(activeTab) : null;
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
  // the panel's right edge, bounded [360, window − sidebar − 420] (420 = main
  // min). Sidebar is 0 when collapsed (grid drops its column).
  const clampFor = useCallback((root, clientX) => {
    const R = root.getBoundingClientRect();
    const side = root.classList.contains("side-collapsed") ? 0 : 300;
    return Math.round(Math.max(360, Math.min(R.right - clientX, R.width - side - 420)));
  }, []);

  const onDragStart = useCallback((e) => {
    if (e.button) return;
    e.preventDefault();
    const root = asideRef.current?.closest(".app");
    if (!root) return;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const move = (ev) => { root.style.setProperty("--sp-w", clampFor(root, ev.clientX) + "px"); };
    const up = (ev) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      ui.setSidePanelWidth(clampFor(root, ev.clientX));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, [clampFor, ui]);

  // Fullscreen = expand to the max clamp; toggle back to the default width.
  const onFullscreen = useCallback(() => {
    const root = asideRef.current?.closest(".app");
    if (!root) return;
    const R = root.getBoundingClientRect();
    const side = root.classList.contains("side-collapsed") ? 0 : 300;
    const max = Math.max(360, Math.round(R.width - side - 420));
    ui.setSidePanelWidth(ui.sidePanelWidth && ui.sidePanelWidth >= max - 1 ? null : max);
  }, [ui]);

  const pickTab = (t) => { ui.setTab(t); setPlusOpen(false); };

  return (
    <aside className="side-panel" ref={asideRef} onMouseDownCapture={() => ui.setFocusedRegion("panel")}>
      <div className="sp-resize" onPointerDown={onDragStart} onDoubleClick={() => ui.setSidePanelWidth(null)} title="Drag to resize" />
      <div className="sp-tabbar">
        {openTabs.map((type) => (
          <TabPill
            key={type}
            type={type}
            label={TAB_LABELS[type] ?? type}
            active={type === activeTab}
            onSelect={() => ui.setTab(type)}
            onClose={() => ui.closeTab(type)}
          />
        ))}
        <span className={"sp-plus" + (plusOpen ? " on" : "")} onClick={() => setPlusOpen((v) => !v)} title="New tab" role="button">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M8 3v10M3 8h10" /></svg>
          {plusOpen && <PlusMenu onPick={pickTab} />}
        </span>
        <span className="sp-spacer" />
        <span className="sp-chrome-btn" onClick={onFullscreen} title="Fullscreen" role="button">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 3h4v4M7 13H3V9M8 8l5-5M8 8l-5 5" /></svg>
        </span>
        <span className="sp-chrome-btn" onClick={ui.closePanel} title="Close" role="button">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="m4 4 8 8M12 4l-8 8" /></svg>
        </span>
      </div>
      <div className="sp-content">
        {panel ? <panel.Component live={live} /> : <EmptyPanel />}
      </div>
    </aside>
  );
}
