import { useEffect, useRef, useState } from "react";
import { useUi } from "../../../state/ui.jsx";
import { listPanels, panelMinSize } from "../../../lib/panelRegistry.js";
import { computePanelRects, computePanelHandles, clampSplit } from "../../../lib/panelTiling.js";
import { setDockWidth, forgetDock } from "../../../state/dockMetrics.js";
import { PanelFrame } from "./PanelFrame.jsx";
import "./registerPanels.js";

// One pane's dock: lays its ≤3 open panels out via the pure tiling engine. Each
// open viewer mounts inside its own absolutely-positioned slot, iterated in stable
// REGISTRY order (not slot order) so a reflow (open/close/resize) only changes each
// slot's rect style — the viewer's DOM subtree is never re-parented, so a live PTY
// keeps its scrollback. Rendered inside PaneScopeContext(paneId) so useUi resolves
// to this pane. Fills the .pane-panel-slot / .pane-dock provided by PaneGrid.
export function PanelDock({ live, paneId }) {
  const ui = useUi();
  const openTypes = ui.openPanelTypes;
  const ratios = ui.dockRatios;
  const rootRef = useRef(null);
  const [resizing, setResizing] = useState(false);

  // Publish the dock's live width for the 3rd-panel open guard (dockMetrics);
  // the divider clamps read the live rect directly at drag time.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => setDockWidth(paneId, el.getBoundingClientRect().width);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => { ro.disconnect(); forgetDock(paneId); };
  }, [paneId]);

  const slots = openTypes.map((type) => ({ type }));
  const rects = computePanelRects(slots, ratios);
  const rectByType = new Map(rects.map((r) => [r.type, r.rect]));
  const handles = computePanelHandles(openTypes.length, ratios);

  // The two adjacent panels' px minimums along a divider's drag axis.
  const minsFor = (id) => {
    if (id === "v") {
      return { a: panelMinSize(openTypes[0]).minH, b: panelMinSize(openTypes[1]).minH };
    }
    const leftMin = Math.max(panelMinSize(openTypes[0]).minW, panelMinSize(openTypes[1]).minW);
    return { a: leftMin, b: panelMinSize(openTypes[2]).minW };
  };

  return (
    <div className={"panel-dock-grid" + (resizing ? " is-resizing" : "")} ref={rootRef}>
      {listPanels().filter((p) => rectByType.has(p.type)).map((p) => (
        <PanelFrame key={p.type} rect={rectByType.get(p.type)}>
          <p.Component live={live} />
        </PanelFrame>
      ))}
      {handles.map((h) => {
        const m = minsFor(h.id);
        return (
          <PanelDivider
            key={h.id}
            h={h}
            rootRef={rootRef}
            minA={m.a}
            minB={m.b}
            onRatio={(f) => ui.setDockRatio(h.id, f)}
            onStart={() => setResizing(true)}
            onEnd={() => setResizing(false)}
          />
        );
      })}
    </div>
  );
}

// Generalized axis-aware divider: the dock-edge handle's pointer-capture idiom
// (PaneGrid PanelResizeHandle), measured against the dock frame, driving the v/col
// ratio. Two-sided px-min clamp (clampSplit) hard-stops before a panel is crushed.
// axis "x" = vertical handle (ew-resize, column split); "y" = horizontal (ns).
function PanelDivider({ h, rootRef, minA, minB, onRatio, onStart, onEnd }) {
  const start = (e) => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); onStart(); };
  const move = (e) => {
    if (!(e.buttons & 1)) return;
    const g = rootRef.current?.getBoundingClientRect();
    if (!g) return;
    const frac = h.axis === "x" ? (e.clientX - g.left) / g.width : (e.clientY - g.top) / g.height;
    const containerPx = h.axis === "x" ? g.width : g.height;
    onRatio(clampSplit(frac, minA, minB, containerPx));
  };
  const style = h.axis === "x"
    ? { left: `${h.pos}%`, top: `${h.cross}%`, height: `${h.crossLen}%` }
    : { top: `${h.pos}%`, left: `${h.cross}%`, width: `${h.crossLen}%` };
  return (
    <div
      className={"panel-divider panel-divider--" + (h.axis === "x" ? "v" : "h")}
      style={style}
      onPointerDown={start}
      onPointerMove={move}
      onLostPointerCapture={onEnd}
    />
  );
}
