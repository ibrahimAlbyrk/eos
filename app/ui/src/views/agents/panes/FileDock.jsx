import { useCallback, useEffect, useRef, useState } from "react";
import { useUi } from "../../../state/ui.jsx";
import { fileTabId } from "../../../lib/panelTabs.js";
import { currentFile, stepFile, closeDock, dropFile, setDockHeight, toggleDockMax } from "../../../lib/fileDock.js";
import { FileView } from "../messages/FileViewer.jsx";

// Resize bounds inside the panel body: the dock and the tab above it each keep
// at least this much height.
const MIN_DOCK_PX = 120;
const MIN_TAB_PX = 120;
const DEFAULT_DOCK_FRAC = 0.45;

const ICON = { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" };

// The side panel's file dock: an opened file lands here, under the active tab,
// which stays as it was. Back/forward walk the files opened here; pin turns
// the file into its own tab. `fill` = no tab above, so the dock takes the body.
export function FileDock({ live, fill }) {
  const ui = useUi();
  const dock = ui.fileDock;
  const path = currentFile(dock);
  const ref = useRef(null);

  // ⌘F belongs to the dock while it was the last thing clicked; otherwise it
  // falls through to a pinned file tab above.
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    const onDown = (e) => setFocused(Boolean(ref.current?.contains(e.target)));
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, []);

  // Height = distance from the pointer to the body's bottom over the body's
  // height, bounded so neither the dock nor the tab above collapses.
  const onResizeStart = useCallback((e) => {
    if (e.button) return;
    e.preventDefault();
    const el = ref.current;
    const body = el?.parentElement;
    if (!el || !body) return;
    const fracAt = (clientY) => {
      const R = body.getBoundingClientRect();
      return Math.max(MIN_DOCK_PX, Math.min(R.bottom - clientY, R.height - MIN_TAB_PX)) / R.height;
    };
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    const move = (ev) => { el.style.setProperty("--fdock-h", fracAt(ev.clientY) * 100 + "%"); };
    const up = (ev) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      ui.updateDock((d) => setDockHeight(d, fracAt(ev.clientY)));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, [ui]);

  if (!path) return null;

  const pin = () => { ui.openFileTab(path); ui.updateDock(closeDock); };
  const lead = (
    <>
      <button className="fv-icon-btn fdock-nav" onClick={() => ui.updateDock((d) => stepFile(d, -1))} disabled={dock.index <= 0} title="Back" aria-label="Back">
        <svg {...ICON}><path d="M10 4 6 8l4 4" /></svg>
      </button>
      <button className="fv-icon-btn fdock-nav" onClick={() => ui.updateDock((d) => stepFile(d, 1))} disabled={dock.index >= dock.history.length - 1} title="Forward" aria-label="Forward">
        <svg {...ICON}><path d="m6 4 4 4-4 4" /></svg>
      </button>
    </>
  );
  const trail = (
    <div className="fv-actions">
      <button className="fv-icon-btn" onClick={pin} title="Open as tab" aria-label="Open as tab">
        <svg {...ICON}><path d="M6 2h4l-.5 4 2.5 2.5H4L6.5 6z" /><path d="M8 8.5V14" /></svg>
      </button>
      {!fill && (
        <button className={"fv-icon-btn" + (dock.max ? " on" : "")} onClick={() => ui.updateDock(toggleDockMax)} title={dock.max ? "Restore" : "Maximize"} aria-label={dock.max ? "Restore" : "Maximize"}>
          {dock.max
            ? <svg {...ICON}><path d="M13 3 9 7V3M9 7h4M3 13l4-4v4M7 9H3" /></svg>
            : <svg {...ICON}><path d="M9 3h4v4M7 13H3V9M8 8l5-5M8 8l-5 5" /></svg>}
        </button>
      )}
      <button className="fv-icon-btn" onClick={() => ui.updateDock(closeDock)} title="Close" aria-label="Close">
        <svg {...ICON} strokeWidth={1.6}><path d="M4 4l8 8M12 4l-8 8" /></svg>
      </button>
    </div>
  );

  return (
    <section
      ref={ref}
      className={"fdock" + (fill ? " fdock--fill" : "")}
      style={{ "--fdock-h": (dock.height || DEFAULT_DOCK_FRAC) * 100 + "%" }}
      aria-label="File preview"
    >
      {!fill && !dock.max && (
        <div className="fdock-resize" onPointerDown={onResizeStart} onDoubleClick={() => ui.updateDock((d) => setDockHeight(d, null))} title="Drag to resize" />
      )}
      <FileView
        key={path}
        path={path}
        live={live}
        reveal={ui.panelData?.[fileTabId(path)]?.reveal}
        findActive={focused && ui.focusedRegion === "panel"}
        findPriority={11}
        onRemove={() => ui.updateDock((d) => dropFile(d, path))}
        lead={lead}
        trail={trail}
      />
    </section>
  );
}
