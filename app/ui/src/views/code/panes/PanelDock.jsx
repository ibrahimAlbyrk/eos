import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useUi } from "../../../state/ui.jsx";
import { listPanels, panelMinSize } from "../../../lib/panelRegistry.js";
import { computePanelRects, computePanelHandles, columnize, columnBounds, clampSplit, clampBoundary } from "../../../lib/panelTiling.js";
import { setDockWidth, forgetDock } from "../../../state/dockMetrics.js";
import { subscribe as subscribeDockFullscreen, fullscreenType, setDockFullscreen } from "../../../state/dockFullscreenStore.js";
import { PanelFrame } from "./PanelFrame.jsx";
import "./registerPanels.js";

// One pane's dock: lays its ≤6 open panels out via the pure tiling engine. Each
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

  // Publish the dock's live width for the new-column open guard (dockMetrics);
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

  // Which panel (if any) is maximized in this pane. When set, that panel alone
  // fills the dock and every other panel is hidden (kept mounted — see below), so
  // maximize shows ONE panel, not all of them widened. Ignore a stale target
  // (its panel was closed); an effect then retires it so the dock un-fills.
  const readMaxType = useCallback(() => fullscreenType(paneId), [paneId]);
  const maxType = useSyncExternalStore(
    useCallback((cb) => subscribeDockFullscreen(paneId, cb), [paneId]),
    readMaxType,
    readMaxType,
  );
  const maximized = maxType && openTypes.includes(maxType) ? maxType : null;
  useEffect(() => {
    if (maxType && !openTypes.includes(maxType)) setDockFullscreen(paneId, false);
  }, [maxType, openTypes, paneId]);

  const slots = openTypes.map((type) => ({ type }));
  const rects = computePanelRects(slots, ratios);
  const rectByType = new Map(rects.map((r) => [r.type, r.rect]));
  const FULL_RECT = { left: 0, top: 0, width: 100, height: 100 };
  // Maximized: no split handles (the sole panel spans the dock).
  const handles = maximized ? [] : computePanelHandles(openTypes.length, ratios);
  const cols = columnize(openTypes.length);
  const { xs } = columnBounds(openTypes.length, ratios);
  const colMinW = (k) => Math.max(...cols[k].map((i) => panelMinSize(openTypes[i]).minW));

  // Per handle id: the two adjacent panels'/columns' px minimums along its drag
  // axis. A boundary c{k} also carries its neighbor-boundary fractions (lo/hi) so
  // the drag can't cross them. v{k} splits column k's stacked pair by height.
  const minsFor = (id) => {
    const k = parseInt(id.slice(1), 10);
    if (id[0] === "v") {
      return { a: panelMinSize(openTypes[2 * k]).minH, b: panelMinSize(openTypes[2 * k + 1]).minH };
    }
    return { a: colMinW(k), b: colMinW(k + 1), lo: xs[k], hi: xs[k + 2] };
  };

  return (
    <div className={"panel-dock-grid" + (resizing ? " is-resizing" : "")} ref={rootRef}>
      {listPanels().filter((p) => rectByType.has(p.type)).map((p) => (
        <PanelFrame
          key={p.type}
          rect={maximized === p.type ? FULL_RECT : rectByType.get(p.type)}
          hidden={maximized ? maximized !== p.type : false}
        >
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
            loBound={m.lo}
            hiBound={m.hi}
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
// (PaneGrid PanelResizeHandle), measured against the dock frame, driving a v{k}/c{k}
// ratio. Two-sided px-min clamps hard-stop before a panel is crushed — clampSplit
// for a column's vertical split, clampBoundary for a column boundary (neighbor-
// aware). axis "x" = vertical handle (ew-resize, column boundary); "y" = horizontal.
function PanelDivider({ h, rootRef, minA, minB, loBound, hiBound, onRatio, onStart, onEnd }) {
  const start = (e) => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); onStart(); };
  const move = (e) => {
    if (!(e.buttons & 1)) return;
    const g = rootRef.current?.getBoundingClientRect();
    if (!g) return;
    if (h.axis === "x") {
      onRatio(clampBoundary((e.clientX - g.left) / g.width, minA, minB, g.width, loBound, hiBound));
    } else {
      onRatio(clampSplit((e.clientY - g.top) / g.height, minA, minB, g.height));
    }
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
