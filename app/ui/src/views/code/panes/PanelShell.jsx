import { useCallback, useSyncExternalStore } from "react";
import { useUi } from "../../../state/ui.jsx";
import { getPanel, closePanelType } from "../../../lib/panelRegistry.js";
import { subscribe as subscribeDockFullscreen, fullscreenType, setDockFullscreen } from "../../../state/dockFullscreenStore.js";
import { DockChromeInset } from "../../../components/DockChromeInset.jsx";
import { PanelCloseButton } from "../messages/PanelCloseButton.jsx";

// PanelShell — the ONE shared chrome for every docked right-panel viewer: the
// island surface plus the header bar [chrome inset · title · viewer actions ·
// fullscreen · close]. A viewer supplies only its slots:
//   type     — registry type; resolves the default label and the close(ui)
//              authority (registerPanels.js), so any close side-effects stay in
//              ONE place.
//   title    — optional; a string gets the standard label typography, a node
//              renders as-is inside the flex title area (crumbs, tab strips).
//              Defaults to the registry label.
//   actions  — optional viewer-specific header controls, pinned right between
//              the title area and the shared fullscreen/close pair.
//   children — the panel body.
// Fullscreen reads/writes the pane-keyed dockFullscreenStore, so EVERY panel
// type gets a working toggle; the layout slot (PaneGrid PanelSlot / SinglePane
// dock) owns the geometry reaction. No viewer touches the store or renders its
// own close button anymore.
export function PanelShell({ type, title, actions, children }) {
  const ui = useUi();
  const paneId = ui.paneId;
  // This panel is "fullscreen" only when IT is the maximized one — so its own
  // button reads Exit while every other panel's reads Fullscreen (and pressing
  // another panel's button re-targets the maximize to that panel).
  const readMaxType = useCallback(() => fullscreenType(paneId), [paneId]);
  const maxType = useSyncExternalStore(
    useCallback((cb) => subscribeDockFullscreen(paneId, cb), [paneId]),
    readMaxType,
    readMaxType,
  );
  const fullscreen = maxType === type;
  const label = getPanel(type)?.label ?? type;
  const heading = title ?? label;
  return (
    <div className={"panel-shell panel-shell--" + type}>
      <div className="panel-shell__head">
        <DockChromeInset />
        <div className="panel-shell__title">
          {typeof heading === "string" ? <span className="panel-shell__label">{heading}</span> : heading}
        </div>
        {actions}
        <button
          className="fv-icon-btn"
          title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
          aria-label={fullscreen ? "Exit fullscreen" : `Fullscreen ${label} panel`}
          onClick={() => setDockFullscreen(paneId, fullscreen ? false : type)}
        >
          {fullscreen ? (
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M13 7H9V3M7 13V9H3M9 7l5-5M7 9l-5 5" />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 3h4v4M7 13H3V9M8 8l5-5M8 8l-5 5" />
            </svg>
          )}
        </button>
        <PanelCloseButton onClose={() => closePanelType(type, ui)} />
      </div>
      {children}
    </div>
  );
}
