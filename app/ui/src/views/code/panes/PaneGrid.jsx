import { useState, useRef, useEffect, useCallback, useSyncExternalStore } from "react";
import { useUi } from "../../../state/ui.jsx";
import { subscribe as subscribeDockFullscreen, isDockFullscreen, setDockFullscreen } from "../../../state/dockFullscreenStore.js";
import { useInputNeeded } from "../../../hooks/useInputNeeded.js";
import { computeRects, computeDividers, dropZoneFromPoint, MAX_PANES } from "../../../lib/paneLayout.js";
import { usePaneTransitions } from "../../../hooks/usePaneTransitions.js";
import { Messages } from "../messages/Messages.jsx";
import { TranscriptHost } from "../messages/TranscriptHost.jsx";
import { Composer } from "../center/Composer.jsx";
import { DragAffordance } from "./DragAffordance.jsx";
import { PanelDock } from "./PanelDock.jsx";
import { PaneHeader } from "./PaneHeader.jsx";
import { PaneScopeContext } from "../../../state/paneScope.js";

const pctStyle = (r) => ({ left: `${r.left}%`, top: `${r.top}%`, width: `${r.width}%`, height: `${r.height}%` });

const sameZone = (a, b) => !!a && !!b && a.kind === b.kind && a.edge === b.edge;

// dataTransfer type for an agent dragged from the sidebar into a pane. Panes
// themselves are no longer draggable — the header is now the window-drag strip —
// so an agent drop is the only pane drag source.
const AGENT_TYPE = "application/x-eos-agent";

// Shared drag-to-split behavior: tracks the live drop zone under the cursor and
// fires onDropZone on drop. Used by every pane AND the single-pane view so the
// edge-split + preview works identically whether you're at 1 pane or 9.
function useDropSplit(canSplit, onDropZone) {
  const [zone, setZone] = useState(null);
  // Live pointer + the hovered pane's rect, captured on dragover, drives the
  // portaled DragAffordance (label trails the cursor; pill snaps to the region
  // centroid computed from the rect). Null whenever no drag is over this pane.
  const [pointer, setPointer] = useState(null);
  const isAgentDrag = (e) => e.dataTransfer.types.includes(AGENT_TYPE);
  const zoneFrom = (e, r) => {
    const z = dropZoneFromPoint((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    // Splitting (adding a pane) is capped → replace only past the cap.
    return canSplit ? z : { kind: "replace" };
  };
  const clear = () => { setZone(null); setPointer(null); };
  const handlers = {
    onDragOver: (e) => {
      if (!isAgentDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const r = e.currentTarget.getBoundingClientRect();
      const z = zoneFrom(e, r);
      setZone((prev) => (sameZone(prev, z) ? prev : z));
      setPointer({ x: e.clientX, y: e.clientY, rect: { left: r.left, top: r.top, width: r.width, height: r.height } });
    },
    // contains(relatedTarget): ignore leaves into our own children (the preview
    // would otherwise flicker as the pointer crosses the transcript).
    onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) clear(); },
    onDrop: (e) => {
      if (!isAgentDrag(e)) return;
      const z = zone ?? zoneFrom(e, e.currentTarget.getBoundingClientRect());
      clear();
      const id = e.dataTransfer.getData(AGENT_TYPE);
      if (id) { e.preventDefault(); onDropZone(z, id); }
    },
  };
  return { zone, pointer, handlers };
}

function DropPreview({ zone }) {
  return <div className={"pane-drop-preview pane-drop-preview--" + (zone.kind === "split" ? zone.edge : "replace")} />;
}

// Ephemeral dock-width override, as a fraction of the OWNING pane's rect. Never
// persisted — cleared when the pane's dock closes. This is the dock-edge (dock vs
// transcript) handle only; the intra-dock v/col ratios live in the dock store.
const PANEL_MIN_FRAC = 0.15;
const PANEL_MAX_FRAC = 0.8;
const clampPanelFrac = (f) => Math.min(PANEL_MAX_FRAC, Math.max(PANEL_MIN_FRAC, f));

// Carve the owning pane's rect into [shrunk transcript | dock]. The dock claims a
// single width whatever it tiles inside (PanelDock lays its panels out); closed →
// zero-width but kept in flow. `open` = the pane has ≥1 docked panel.
const DOCK_DEFAULT_FRAC = 0.5;
function dockSplit(rect, open, frac) {
  const f = open ? (frac ?? DOCK_DEFAULT_FRAC) : 0;
  const pw = rect.width * f;
  return {
    paneRect: { ...rect, width: rect.width - pw },
    panelRect: { left: rect.left + rect.width - pw, top: rect.top, width: pw, height: rect.height },
  };
}

// Drag handle on a docked panel's left edge (Divider idiom: pointer capture,
// ratio computed in the owning pane's rect). rect is the pane's FULL rect in
// containerRef's % frame; onFrac receives the clamped panel fraction.
function PanelResizeHandle({ containerRef, rect, onFrac, onResizeStart, onResizeEnd }) {
  const start = (e) => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); onResizeStart?.(); };
  const move = (e) => {
    if (!(e.buttons & 1)) return;
    const g = containerRef.current?.getBoundingClientRect();
    if (!g) return;
    const x = ((e.clientX - g.left) / g.width) * 100;
    onFrac(clampPanelFrac((rect.left + rect.width - x) / rect.width));
  };
  return (
    <div
      className="panel-resize-handle"
      onPointerDown={start}
      onPointerMove={move}
      onLostPointerCapture={onResizeEnd}
    />
  );
}

// One pane's docked-panel slot. Subscribes to that pane's dockFullscreenStore so
// a dock fullscreen toggle re-renders ONLY this slot: fullscreen overrides the
// slot rect to fill its OWN pane's rect (not the whole grid, so sibling panes stay
// uncovered) — the .pane-slot 240ms geometry transition animates the grow/shrink —
// and makes the dock-edge handle inert.
function PanelSlot({ id, rect, live, gridRef, open, frac, onFrac, onResizeStart, onResizeEnd, onFocusPanel }) {
  const fullscreen = useSyncExternalStore(
    useCallback((cb) => subscribeDockFullscreen(id, cb), [id]),
    useCallback(() => isDockFullscreen(id), [id]),
  );
  // Dock emptied → drop fullscreen so the slot can't stay maximized empty.
  useEffect(() => {
    if (!open && fullscreen) setDockFullscreen(id, false);
  }, [open, fullscreen, id]);
  const slotRect = fullscreen
    ? rect
    : dockSplit(rect, open, frac).panelRect;
  return (
    <div
      // at-top: this pane hugs the grid's top row, so its docked panel may rise
      // over the top bar (see .pane-panel-slot.at-top in styles). A panel beside
      // a lower-row pane keeps its normal top so it can't overlap the pane above.
      // at-top-left: only the grid-origin pane sits under the window chrome when
      // fullscreen, so it alone gets the tab bar's native-chrome inset (styles.css).
      className={"pane-slot pane-panel-slot" + (rect.top === 0 ? " at-top" : "") + (rect.left === 0 && rect.top === 0 ? " at-top-left" : "") + (fullscreen ? " is-fullscreen" : "")}
      style={pctStyle(slotRect)}
      // The slot is a grid SIBLING of its pane, so the Pane's focus capture
      // never sees clicks here. Focus the owning pane, then claim the panel
      // region for ⌘F (after focusLeaf — it resets the region to transcript).
      onMouseDownCapture={onFocusPanel}
    >
      <PaneScopeContext.Provider value={id}>
        <PanelDock live={live} paneId={id} />
      </PaneScopeContext.Provider>
      {/* Dock-edge (dock vs transcript) width handle, rendered AFTER the dock so
          its left-edge hit zone stays grabbable over the grid. Inert in fullscreen
          (the slot spans its whole pane — there is no transcript edge to drag). */}
      {open && !fullscreen && (
        <PanelResizeHandle
          containerRef={gridRef}
          rect={rect}
          onFrac={onFrac}
          onResizeStart={onResizeStart}
          onResizeEnd={onResizeEnd}
        />
      )}
    </div>
  );
}

// Split view: a BSP tree (ui.tree) rendered as a FLAT set of absolutely-
// positioned panes (computeRects) + one divider per split (computeDividers).
// Panes are keyed by leaf id, decoupled from the tree's nesting, so a structural
// edit (split/close) never remounts a surviving pane — only its rect moves
// (keep-alive). Each pane renders ONE agent via the shared <Messages>; only the
// focused pane is isActive and drives the shared UI.
export function PaneGrid({ live }) {
  const ui = useUi();
  const gridRef = useRef(null);
  // is-resizing disables the slot reflow transition for the duration of a divider
  // drag so the resize stays 1:1 with the pointer (state, not a classList toggle,
  // so a mid-drag re-render from setRatioFor can't clobber it).
  const [resizing, setResizing] = useState(false);
  const pulseOn = ui.settings?.["notifications.paneAttention"] !== false;
  const rects = computeRects(ui.tree);
  const dividers = computeDividers(ui.tree);
  const { leaving, setNode } = usePaneTransitions(rects);
  const canClose = rects.length > 1;
  const canSplit = rects.length < MAX_PANES;

  // Each pane owns its OWN docked panel (independent open/close + file per pane):
  // a pane with an open panel yields its right edge to it, carved out of that
  // pane's own rect so neighbours never move — two panes can show their panels at
  // once. ui.topPanelTypeIn(id) reads that pane's stack directly (keyed map).
  // Ephemeral per-pane panel-width overrides (paneId → fraction of pane rect).
  // Dropped whenever that pane's panel is closed, so reopening snaps back to the
  // PANEL_FRAC default. Bail-out keeps the no-op case reference-stable.
  const [panelFracs, setPanelFracs] = useState({});
  useEffect(() => {
    setPanelFracs((m) => {
      const kept = Object.keys(m).filter((id) => ui.hasAnyPanelIn(id));
      return kept.length === Object.keys(m).length ? m : Object.fromEntries(kept.map((id) => [id, m[id]]));
    });
  });
  // A pane whose dock is open counts as open for geometry UNLESS it is collapsing
  // (last panel just closed): then the transcript reclaims its rect while the still-
  // mounted viewer shrinks out with the panel slot (see PanelSlot / dockFullscreen).
  const dockOpenGeom = (id) => ui.hasAnyPanelIn(id) && !ui.isDockCollapsing(id);
  const paneRectOf = (id, rect) => dockSplit(rect, dockOpenGeom(id), panelFracs[id]).paneRect;

  // One slot renderer for both live panes and the leaving ghosts. A ghost keeps
  // the same key (leaf id) and element shape so React keeps the real Pane mounted
  // across the close → the transcript fades out in place, it doesn't remount.
  const renderSlot = ({ id, agentId, rect }, isLeaving = false) => {
    const worker = agentId ? live.workers.find((w) => w.id === agentId) ?? null : null;
    const focused = !isLeaving && id === ui.focusedLeafId;
    // The pane whose rect touches the window's top-left corner owns the native
    // chrome inset (traffic lights + sidebar toggle) now that the strip is gone.
    const topLeft = !isLeaving && rect.left === 0 && rect.top === 0;
    // Top-ROW panes compensate the island chrome above them (grid margin + pane
    // inset + border) so their header content sits at the N=1 bar's window-y.
    const topRow = !isLeaving && rect.top === 0;
    // A pane with an open panel yields its right edge to it (paneRect); a leaving
    // ghost keeps its full rect (no panel).
    const slotRect = isLeaving ? rect : paneRectOf(id, rect);
    return (
      <div
        key={id}
        ref={isLeaving ? setNode(id) : undefined}
        className={"pane-slot" + (isLeaving ? " is-leaving" : "")}
        style={pctStyle(slotRect)}
      >
        <Pane
          id={id}
          agentId={agentId}
          worker={worker}
          live={live}
          focused={focused}
          topLeft={topLeft}
          topRow={topRow}
          attention={pulseOn && !focused && !!worker && ui.needsAttentionRaw(worker)}
          canClose={canClose}
          canSplit={canSplit}
          onFocus={() => ui.focusLeaf(id)}
          onClose={() => ui.closeLeaf(id)}
          onDropZone={(zone, aid) => {
            if (zone.kind === "split") ui.splitWithAgent(id, zone.dir, zone.side, aid);
            else ui.dropReplace(id, aid);
          }}
        />
      </div>
    );
  };

  return (
    <div className={"pane-grid" + (resizing ? " is-resizing" : "")} ref={gridRef}>
      {rects.map((r) => renderSlot(r))}
      {leaving.map((l) => renderSlot(l, true))}
      {/* One docked panel slot PER pane — a grid sibling anchored to that pane's
          right edge (own island chrome, full pane height, outside the pane body
          so no head/fade clips it). Scoped to its pane via PaneScopeContext so the
          viewers read THAT pane's stack (independent per pane). Zero-width when
          that pane has nothing open, but kept mounted (stable key) so a buried
          panel keeps its fetched state and its rect animates on reflow. */}
      {rects.map(({ id, rect }) => (
        <PanelSlot
          key={`panel:${id}`}
          id={id}
          rect={rect}
          live={live}
          gridRef={gridRef}
          open={dockOpenGeom(id)}
          frac={panelFracs[id]}
          onFrac={(f) => setPanelFracs((m) => ({ ...m, [id]: f }))}
          onResizeStart={() => setResizing(true)}
          onResizeEnd={() => setResizing(false)}
          onFocusPanel={() => { ui.focusLeaf(id); ui.setFocusedRegion("panel"); }}
        />
      ))}
      {dividers.map((d) => (
        <Divider
          key={d.id}
          d={d}
          gridRef={gridRef}
          onRatio={(r) => ui.setRatioFor(d.id, r)}
          onResizeStart={() => setResizing(true)}
          onResizeEnd={() => setResizing(false)}
        />
      ))}
    </div>
  );
}

// Single pane: keeps the keep-alive transcript multiplexer (instant switch-back),
// but is also a drag-to-split drop target so the first split can be made by drag.
export function SinglePane({ live }) {
  const ui = useUi();
  const leafId = ui.focusedLeafId;
  const selected = live.workers.find((w) => w.id === ui.selectedId) ?? null;
  const { zone, pointer, handlers } = useDropSplit(true, (z, aid) => {
    if (z.kind === "split") ui.splitWithAgent(leafId, z.dir, z.side, aid);
    else ui.dropReplace(leafId, aid);
  });
  // One pane spans the whole center: a horizontal flex row holds the transcript
  // (flex:1) and its dock (flex-basis = its share of the width). The transcript
  // stays a flex-1 child of a flex-column so it never collapses. Closed → the dock
  // is zero-basis but kept in flow.
  const dockOpen = ui.openPanelTypes.length > 0;
  // Ephemeral dock-width override (fraction of the full row) — reset on close so
  // reopening snaps back to the default. is-resizing kills the flex-basis ease so
  // the drag tracks the pointer 1:1.
  const rootRef = useRef(null);
  const [panelFrac, setPanelFrac] = useState(null);
  const [panelResizing, setPanelResizing] = useState(false);
  useEffect(() => { if (!dockOpen) setPanelFrac(null); }, [dockOpen]);
  // Dock fullscreen for this pane: the dock KEEPS its normal in-flow width (so the
  // transcript beside it never reflows) and its .panel-dock-grid OVERLAYS the whole
  // single-pane by expanding left+width past the dock box (--fs-left/--fs-width,
  // computed below). A transition on those two animates the grow/shrink to match the
  // split-pane .pane-slot geometry ease. panelFrac is untouched, so exiting restores
  // the prior split.
  const fullscreen = useSyncExternalStore(
    useCallback((cb) => subscribeDockFullscreen(leafId, cb), [leafId]),
    useCallback(() => isDockFullscreen(leafId), [leafId]),
  );
  // Dock emptied → drop fullscreen so the row can't stay maximized empty.
  useEffect(() => {
    if (!dockOpen && fullscreen) setDockFullscreen(leafId, false);
  }, [dockOpen, fullscreen, leafId]);
  // A collapsing pane (its last panel just closed) animates its width to 0 with the
  // viewer still mounted, so treat it as closed for geometry and suppress fullscreen.
  const collapsing = ui.isDockCollapsing(leafId);
  const fs = fullscreen && !collapsing;
  const dockWidth = (dockOpen && !collapsing) ? (panelFrac != null ? panelFrac * 100 : DOCK_DEFAULT_FRAC * 100) : 0;
  // Fullscreen overlay geometry for .panel-dock-grid, expressed in the dock's OWN
  // width frame so left+width can transition: shift left back over .sp-main and
  // widen to the full row, landing the grid flush over .single-pane (0…100%).
  const fsLeft = dockWidth > 0 ? `${-((100 - dockWidth) / dockWidth) * 100}%` : "0%";
  const fsWidth = dockWidth > 0 ? `${10000 / dockWidth}%` : "100%";
  return (
    <div className="single-pane" ref={rootRef} {...handlers}>
      {zone && <DropPreview zone={zone} />}
      {zone && pointer && <DragAffordance pointer={pointer} zone={zone} />}
      {/* Transcript + its per-pane composer stack in a column; the docked panel
          sits alongside them (full height) so the composer spans the transcript
          width only, matching the split-pane layout. Same Composer component,
          N=1 case — this is the ONLY spot the no-agent spawn flow lives. */}
      {/* Region handlers mirror the split-pane pair: transcript side vs. docked
          panel decide which one owns ⌘F (state/pane.jsx focusedRegion). */}
      <div className="sp-main" onMouseDownCapture={() => ui.setFocusedRegion("transcript")}>
        {/* Same PaneHeader as the split panes, scoped to the single leaf. No agent
            → the new-session ("new orchestrator") breadcrumb; close is hidden. */}
        <PaneScopeContext.Provider value={leafId}>
          <PaneHeader
            worker={selected}
            live={live}
            attention={false}
            needsInput={false}
            canClose={false}
            onClose={() => {}}
            topLeft
          />
          <div className="pane-tx">
            <TranscriptHost live={live} activeId={ui.selectedId} />
          </div>
          <Composer live={live} worker={selected} paneId={leafId} focused />
        </PaneScopeContext.Provider>
      </div>
      <div
        // at-top-left: the single pane always spans the content area from its top-
        // left, so its fullscreen dock always takes the native-chrome inset.
        className={"pane-panel-slot pane-dock at-top-left" + (panelResizing ? " is-resizing" : "") + (fs ? " is-fullscreen" : "")}
        style={{ flexBasis: `${dockWidth}%`, "--fs-left": fsLeft, "--fs-width": fsWidth }}
        onMouseDownCapture={() => ui.setFocusedRegion("panel")}
      >
        <PaneScopeContext.Provider value={leafId}>
          <PanelDock live={live} paneId={leafId} />
        </PaneScopeContext.Provider>
        {dockOpen && !collapsing && !fullscreen && (
          <PanelResizeHandle
            containerRef={rootRef}
            rect={{ left: 0, width: 100 }}
            onFrac={setPanelFrac}
            onResizeStart={() => setPanelResizing(true)}
            onResizeEnd={() => setPanelResizing(false)}
          />
        )}
      </div>
    </div>
  );
}

// Per-split resize handle. Pointer-capture drag (EffortPopover idiom): the ratio
// is computed within the SPLIT's own rect, so dragging only resizes that split's
// two children. Double-click resets to 0.5.
function Divider({ d, gridRef, onRatio, onResizeStart, onResizeEnd }) {
  const start = (e) => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); onResizeStart(); };
  const move = (e) => {
    if (!(e.buttons & 1)) return;
    const g = gridRef.current?.getBoundingClientRect();
    if (!g) return;
    const r = d.dir === "row"
      ? ((e.clientX - g.left) / g.width * 100 - d.rect.left) / d.rect.width
      : ((e.clientY - g.top) / g.height * 100 - d.rect.top) / d.rect.height;
    onRatio(r);
  };
  const style = d.dir === "row"
    ? { left: `${d.pos}%`, top: `${d.rect.top}%`, height: `${d.rect.height}%` }
    : { top: `${d.pos}%`, left: `${d.rect.left}%`, width: `${d.rect.width}%` };
  return (
    <div
      className={`pane-divider pane-divider--${d.dir === "row" ? "v" : "h"}`}
      style={style}
      onPointerDown={start}
      onPointerMove={move}
      onLostPointerCapture={onResizeEnd}
      onDoubleClick={() => onRatio(0.5)}
    />
  );
}

function Pane({ id, agentId, worker, live, focused, topLeft, topRow, attention, canClose, canSplit, onFocus, onClose, onDropZone }) {
  // Blocked-on-input cue for non-focused panes: an open ask_user question
  // (per-agent store) or a pending permission (live.pendingPermissions). The
  // focused pane needs none — its banner is in the shared composer.
  const questionNeeded = useInputNeeded(agentId);
  const { zone, pointer, handlers } = useDropSplit(canSplit, onDropZone);
  const permNeeded = !!worker && (live.pendingPermissions ?? []).some((p) => p.worker_id === agentId);
  const needsInput = !focused && !!worker && (questionNeeded || permNeeded);
  // needs-input takes precedence over the attention pulse (more urgent).
  const cls = ["pane", focused ? "is-focused" : "",
    needsInput ? "pane--needs-input" : attention ? "pane--attention" : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={cls}
      // Capture so a click that also hits a transcript link/button still focuses
      // the pane first. mousedown (not click) makes focus feel immediate. Runs
      // even when already focused so a click anywhere in the pane hands ⌘F back
      // to the transcript region (focusLeaf resets focusedRegion; re-focusing is
      // a no-op otherwise).
      onMouseDownCapture={onFocus}
      {...handlers}
    >
      {zone && <DropPreview zone={zone} />}
      {zone && pointer && <DragAffordance pointer={pointer} zone={zone} />}
      {/* Header + body share ONE pane scope: the header's terminal/split/menu and
          the composer's panel actions all resolve to THIS pane, zero prop-drilling. */}
      <PaneScopeContext.Provider value={id}>
        <PaneHeader
          worker={worker}
          live={live}
          attention={attention}
          needsInput={needsInput}
          canClose={canClose}
          onClose={onClose}
          topLeft={topLeft}
          topRow={topRow}
          split
        />
        {/* Every split pane is rendered on screen regardless of focus, so all are
            visible (and may animate); only the focused one is isActive (shared UI).
            An EMPTY pane (no agent) shows the SAME new-session transcript + composer
            as the single-pane new-session state: agentId/worker are null, so the
            composer drops into its no-agent spawn flow — type a prompt and it spawns
            an orchestrator into this (focused) pane. No separate agent picker. */}
        <Messages live={live} agentId={agentId} isActive={focused} visible={true} />
        <Composer live={live} worker={worker} paneId={id} focused={focused} />
      </PaneScopeContext.Provider>
    </div>
  );
}
