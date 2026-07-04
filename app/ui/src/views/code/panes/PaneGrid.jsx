import { useState, useRef, useEffect } from "react";
import { useUi } from "../../../state/ui.jsx";
import { useInputNeeded } from "../../../hooks/useInputNeeded.js";
import { computeRects, computeDividers, dropZoneFromPoint, leafOfAgent, splitRectForPanel, MAX_PANES } from "../../../lib/paneLayout.js";
import { usePaneTransitions } from "../../../hooks/usePaneTransitions.js";
import { Messages } from "../messages/Messages.jsx";
import { TranscriptHost } from "../messages/TranscriptHost.jsx";
import { Composer } from "../center/Composer.jsx";
import { AgentPickerOverlay } from "./AgentPickerOverlay.jsx";
import { DragAffordance } from "./DragAffordance.jsx";
import { PaneViewers } from "./PaneViewers.jsx";
import { PaneHeader } from "./PaneHeader.jsx";
import { PaneScopeContext } from "../../../state/paneScope.js";

const pctStyle = (r) => ({ left: `${r.left}%`, top: `${r.top}%`, width: `${r.width}%`, height: `${r.height}%` });

const sameZone = (a, b) => !!a && !!b && a.kind === b.kind && a.edge === b.edge;

// dataTransfer types: an agent dragged in from the sidebar vs. a pane dragged by
// its header. Distinct types so a drop target can tell them apart and route them
// differently (split/replace vs. swap/move).
const AGENT_TYPE = "application/x-eos-agent";
const PANE_TYPE = "application/x-eos-pane";

// Transparent 1×1 drag ghost so the browser's native preview is suppressed and
// the custom DragAffordance is what the user sees (mirrors AgentsTree's const;
// kept local — no import across the sidebar boundary).
const TRANSPARENT_DRAG_IMG = typeof Image === "function" ? new Image() : null;
if (TRANSPARENT_DRAG_IMG) {
  TRANSPARENT_DRAG_IMG.src =
    "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
}

// The leaf id of the pane currently being header-dragged, so a pane's own drop
// target can ignore itself during dragover (dataTransfer.getData is unreadable
// until drop). Module-level since only one drag runs at a time, and the source
// pane and the hovered pane are different component instances.
let draggedPaneId = null;

// Shared drag-to-split behavior: tracks the live drop zone under the cursor and
// fires onDropZone on drop. Used by every pane AND the single-pane view so the
// edge-split + preview works identically whether you're at 1 pane or 9. When a
// pane (not an agent) is the drag source, `onPaneDrop` routes it instead and
// `selfId` lets the source pane ignore itself; both omitted = agent-only target.
function useDropSplit(canSplit, onDropZone, onPaneDrop, selfId) {
  const [zone, setZone] = useState(null);
  // Live pointer + the hovered pane's rect, captured on dragover, drives the
  // portaled DragAffordance (label trails the cursor; pill snaps to the region
  // centroid computed from the rect). Null whenever no drag is over this pane.
  const [pointer, setPointer] = useState(null);
  // True while the active drag is a pane (vs. an agent) — flips the affordance
  // copy ("Swap"/"Move here") without DragAffordance knowing the source.
  const [paneDrag, setPaneDrag] = useState(false);
  // Which kind of drag is over us, or null. A pane-drag over its own source pane
  // counts as none (self-reposition is a no-op) so no affordance shows there.
  const dragKind = (e) => {
    const types = e.dataTransfer.types;
    if (onPaneDrop && types.includes(PANE_TYPE)) return draggedPaneId === selfId ? null : "pane";
    if (types.includes(AGENT_TYPE)) return "agent";
    return null;
  };
  const zoneFrom = (e, r, kind) => {
    const z = dropZoneFromPoint((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    // Splitting (adding a pane) is capped → replace only; a pane MOVE is
    // net-neutral so its edge zones stay live even at the cap.
    return canSplit || kind === "pane" ? z : { kind: "replace" };
  };
  const clear = () => { setZone(null); setPointer(null); setPaneDrag(false); };
  const handlers = {
    onDragOver: (e) => {
      const kind = dragKind(e);
      if (!kind) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const r = e.currentTarget.getBoundingClientRect();
      const z = zoneFrom(e, r, kind);
      setZone((prev) => (sameZone(prev, z) ? prev : z));
      setPointer({ x: e.clientX, y: e.clientY, rect: { left: r.left, top: r.top, width: r.width, height: r.height } });
      setPaneDrag(kind === "pane");
    },
    // contains(relatedTarget): ignore leaves into our own children (the preview
    // would otherwise flicker as the pointer crosses the transcript).
    onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) clear(); },
    onDrop: (e) => {
      const kind = dragKind(e);
      const z = zone ?? zoneFrom(e, e.currentTarget.getBoundingClientRect(), kind);
      clear();
      const paneId = onPaneDrop ? e.dataTransfer.getData(PANE_TYPE) : "";
      if (paneId) {
        e.preventDefault();
        if (paneId !== selfId) onPaneDrop(z, paneId); // dropping a pane on itself: no-op
        return;
      }
      const id = e.dataTransfer.getData(AGENT_TYPE);
      if (id) { e.preventDefault(); onDropZone(z, id); }
    },
  };
  return { zone, pointer, paneDrag, handlers };
}

function DropPreview({ zone }) {
  return <div className={"pane-drop-preview pane-drop-preview--" + (zone.kind === "split" ? zone.edge : "replace")} />;
}

// Ephemeral panel-width override, as a fraction of the OWNING pane's rect (same
// unit as PANEL_FRAC). Never persisted — cleared when the panel closes.
const PANEL_MIN_FRAC = 0.15;
const PANEL_MAX_FRAC = 0.6;
const clampPanelFrac = (f) => Math.min(PANEL_MAX_FRAC, Math.max(PANEL_MIN_FRAC, f));

// splitRectForPanel with the override applied on top of its result, keeping the
// layout function itself pure. frac == null → default PANEL_FRAC geometry.
function panelSplit(rect, type, frac) {
  const split = splitRectForPanel(rect, type);
  if (!type || frac == null) return split;
  const pw = rect.width * frac;
  return {
    paneRect: { ...rect, width: rect.width - pw },
    panelRect: { ...split.panelRect, left: rect.left + rect.width - pw, width: pw },
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
  // Agents already shown in some pane — the empty-pane picker dims these and
  // focuses their existing pane instead of duplicating them.
  const shownAgentIds = new Set(rects.map((r) => r.agentId).filter(Boolean));

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
      const kept = Object.keys(m).filter((id) => ui.topPanelTypeIn(id));
      return kept.length === Object.keys(m).length ? m : Object.fromEntries(kept.map((id) => [id, m[id]]));
    });
  });
  const paneRectOf = (id, rect) => panelSplit(rect, ui.topPanelTypeIn(id), panelFracs[id]).paneRect;

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
          excludeIds={shownAgentIds}
          attention={pulseOn && !focused && !!worker && ui.needsAttentionRaw(worker)}
          canClose={canClose}
          canSplit={canSplit}
          onFocus={() => ui.focusLeaf(id)}
          onClose={() => ui.closeLeaf(id)}
          onPick={(aid) => {
            // Dedup: if the agent is already in another pane, focus that pane
            // instead of duplicating it; otherwise fill this empty pane.
            const existing = leafOfAgent(ui.tree, aid);
            if (existing && existing.id !== id) ui.focusLeaf(existing.id);
            else ui.dropReplace(id, aid);
          }}
          onDropZone={(zone, aid) => {
            if (zone.kind === "split") ui.splitWithAgent(id, zone.dir, zone.side, aid);
            else ui.dropReplace(id, aid);
          }}
          onPaneDrop={(zone, srcLeafId) => {
            // Header dragged from another pane: edge → relocate, center → swap.
            if (zone.kind === "split") ui.movePane(srcLeafId, id, zone.dir, zone.side);
            else ui.swapPanes(srcLeafId, id);
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
      {rects.map(({ id, rect }) => {
        const panelType = ui.topPanelTypeIn(id);
        return (
          <div
            key={`panel:${id}`}
            // at-top: this pane hugs the grid's top row, so its docked panel may rise
            // over the top bar (see .pane-panel-slot.at-top in styles). A panel beside
            // a lower-row pane keeps its normal top so it can't overlap the pane above.
            className={"pane-slot pane-panel-slot" + (rect.top === 0 ? " at-top" : "")}
            style={pctStyle(panelSplit(rect, panelType, panelFracs[id]).panelRect)}
            // The slot is a grid SIBLING of its pane, so the Pane's focus capture
            // never sees clicks here. Focus the owning pane, then claim the panel
            // region for ⌘F (after focusLeaf — it resets the region to transcript).
            onMouseDownCapture={() => { ui.focusLeaf(id); ui.setFocusedRegion("panel"); }}
          >
            {panelType && (
              <PanelResizeHandle
                containerRef={gridRef}
                rect={rect}
                onFrac={(f) => setPanelFracs((m) => ({ ...m, [id]: f }))}
                onResizeStart={() => setResizing(true)}
                onResizeEnd={() => setResizing(false)}
              />
            )}
            <PaneScopeContext.Provider value={id}>
              <PaneViewers live={live} />
            </PaneScopeContext.Provider>
          </div>
        );
      })}
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
  // (flex:1) and its docked panel (flex-basis = its share of the width). The
  // transcript stays a flex-1 child of a flex-column (.sp-body) — the same layout
  // context it renders in without a panel — so it never collapses. Closed → the
  // panel is zero-basis but kept mounted (keep-alive).
  const { panelRect } = splitRectForPanel({ left: 0, top: 0, width: 100, height: 100 }, ui.topPanelType);
  // Ephemeral panel-width override (fraction of the full row) — reset on close so
  // reopening snaps back to PANEL_FRAC. is-resizing kills the flex-basis ease so
  // the drag tracks the pointer 1:1.
  const rootRef = useRef(null);
  const [panelFrac, setPanelFrac] = useState(null);
  const [panelResizing, setPanelResizing] = useState(false);
  useEffect(() => { if (!ui.topPanelType) setPanelFrac(null); }, [ui.topPanelType]);
  const dockWidth = ui.topPanelType && panelFrac != null ? panelFrac * 100 : panelRect.width;
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
            newSession
            topLeft
          />
          <div className="pane-tx">
            <TranscriptHost live={live} activeId={ui.selectedId} />
          </div>
          <Composer live={live} worker={selected} paneId={leafId} focused />
        </PaneScopeContext.Provider>
      </div>
      <div
        className={"pane-panel-slot pane-dock" + (panelResizing ? " is-resizing" : "")}
        style={{ flexBasis: `${dockWidth}%` }}
        onMouseDownCapture={() => ui.setFocusedRegion("panel")}
      >
        {ui.topPanelType && (
          <PanelResizeHandle
            containerRef={rootRef}
            rect={{ left: 0, width: 100 }}
            onFrac={setPanelFrac}
            onResizeStart={() => setPanelResizing(true)}
            onResizeEnd={() => setPanelResizing(false)}
          />
        )}
        <PaneViewers live={live} />
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

function Pane({ id, agentId, worker, live, focused, topLeft, topRow, excludeIds, attention, canClose, canSplit, onFocus, onClose, onPick, onDropZone, onPaneDrop }) {
  // Blocked-on-input cue for non-focused panes: an open ask_user question
  // (per-agent store) or a pending permission (live.pendingPermissions). The
  // focused pane needs none — its banner is in the shared composer.
  const questionNeeded = useInputNeeded(agentId);
  const { zone, pointer, paneDrag, handlers } = useDropSplit(canSplit, onDropZone, onPaneDrop, id);
  // This pane is being header-dragged → dim it. Armed on mousedown so the close
  // button (a no-drag control in the header) can't start a drag.
  const [dragging, setDragging] = useState(false);
  const dragArmed = useRef(false);
  const permNeeded = !!worker && (live.pendingPermissions ?? []).some((p) => p.worker_id === agentId);
  const needsInput = !focused && !!worker && (questionNeeded || permNeeded);
  // needs-input takes precedence over the attention pulse (more urgent).
  const cls = ["pane", focused ? "is-focused" : "", dragging ? "pane--dragging" : "",
    needsInput ? "pane--needs-input" : attention ? "pane--attention" : ""]
    .filter(Boolean)
    .join(" ");

  // Drag-to-reposition wiring spread onto the PaneHeader root (the header is the
  // drag handle: drop on another pane to swap, on its edge to move). mousedown
  // fires before dragstart and its target is the real element, so arm the drag
  // only when the press did NOT land on a header control (button/input).
  const dragProps = {
    draggable: true,
    onMouseDown: (e) => { dragArmed.current = !e.target.closest("button, input, [data-window-drag]"); },
    onDragStart: (e) => {
      if (!dragArmed.current) { e.preventDefault(); return; }
      draggedPaneId = id;
      setDragging(true);
      e.dataTransfer.setData(PANE_TYPE, id);
      e.dataTransfer.effectAllowed = "move";
      if (TRANSPARENT_DRAG_IMG) e.dataTransfer.setDragImage(TRANSPARENT_DRAG_IMG, 0, 0);
    },
    onDragEnd: () => { draggedPaneId = null; setDragging(false); },
  };

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
      {zone && pointer && <DragAffordance pointer={pointer} zone={zone} paneDrag={paneDrag} />}
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
          dragProps={dragProps}
          topLeft={topLeft}
          topRow={topRow}
          split
        />
        {worker ? (
          // Every split pane is rendered on screen regardless of focus, so all are
          // visible (and may animate); only the focused one is isActive (shared UI).
          <>
            <Messages live={live} agentId={agentId} isActive={focused} visible={true} />
            <Composer live={live} worker={worker} paneId={id} focused={focused} />
          </>
        ) : (
          <AgentPickerOverlay live={live} excludeIds={excludeIds} focused={focused} dragActive={!!zone} onPick={onPick} />
        )}
      </PaneScopeContext.Provider>
    </div>
  );
}
