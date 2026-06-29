import { useState, useRef } from "react";
import { useUi } from "../../../state/ui.jsx";
import { statusFromState } from "../../../lib/format.js";
import { nameOf, AgentName } from "../../../lib/agentName.js";
import { useInputNeeded } from "../../../hooks/useInputNeeded.js";
import { computeRects, computeDividers, dropZoneFromPoint, leafOfAgent, MAX_PANES } from "../../../lib/paneLayout.js";
import { usePaneTransitions } from "../../../hooks/usePaneTransitions.js";
import { Messages } from "../messages/Messages.jsx";
import { TranscriptHost } from "../messages/TranscriptHost.jsx";
import { AgentPickerOverlay } from "./AgentPickerOverlay.jsx";
import { DragAffordance } from "./DragAffordance.jsx";
import { PanePanel } from "./PanePanel.jsx";
import { PaneScopeContext } from "../../../state/paneScope.js";

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

  // One slot renderer for both live panes and the leaving ghosts. A ghost keeps
  // the same key (leaf id) and element shape so React keeps the real Pane mounted
  // across the close → the transcript fades out in place, it doesn't remount.
  const renderSlot = ({ id, agentId, rect }, isLeaving = false) => {
    const worker = agentId ? live.workers.find((w) => w.id === agentId) ?? null : null;
    const focused = !isLeaving && id === ui.focusedLeafId;
    return (
      <div
        key={id}
        ref={isLeaving ? setNode(id) : undefined}
        className={"pane-slot" + (isLeaving ? " is-leaving" : "")}
        style={{ left: `${rect.left}%`, top: `${rect.top}%`, width: `${rect.width}%`, height: `${rect.height}%` }}
      >
        <Pane
          id={id}
          agentId={agentId}
          worker={worker}
          live={live}
          focused={focused}
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
  const { zone, pointer, handlers } = useDropSplit(true, (z, aid) => {
    if (z.kind === "split") ui.splitWithAgent(leafId, z.dir, z.side, aid);
    else ui.dropReplace(leafId, aid);
  });
  return (
    <div className="single-pane" {...handlers}>
      {zone && <DropPreview zone={zone} />}
      {zone && pointer && <DragAffordance pointer={pointer} zone={zone} />}
      {/* One pane spans the whole center, so its right-docked panel sits at the
          center's right edge — identical horizontal dock to the old window-grid
          mount. */}
      <PaneScopeContext.Provider value={leafId}>
        <div className="pane-body">
          <TranscriptHost live={live} activeId={ui.selectedId} />
          <PanePanel live={live} />
        </div>
      </PaneScopeContext.Provider>
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

function Pane({ id, agentId, worker, live, focused, excludeIds, attention, canClose, canSplit, onFocus, onClose, onPick, onDropZone, onPaneDrop }) {
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
  const status = worker ? statusFromState(worker.state) : null;
  // needs-input takes precedence over the attention pulse (more urgent).
  const cls = ["pane", focused ? "is-focused" : "", dragging ? "pane--dragging" : "",
    needsInput ? "pane--needs-input" : attention ? "pane--attention" : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={cls}
      // Capture so a click that also hits a transcript link/button still focuses
      // the pane first. mousedown (not click) makes focus feel immediate.
      onMouseDownCapture={focused ? undefined : onFocus}
      {...handlers}
    >
      {zone && <DropPreview zone={zone} />}
      {zone && pointer && <DragAffordance pointer={pointer} zone={zone} paneDrag={paneDrag} />}
      <div
        className="pane-head"
        draggable
        // mousedown fires before dragstart and its target is the real element, so
        // arm the drag only when the press did NOT land on the close button (the
        // header is the draggable element, so dragstart.target is the header).
        onMouseDown={(e) => { dragArmed.current = !e.target.closest(".pane-close"); }}
        onDragStart={(e) => {
          if (!dragArmed.current) { e.preventDefault(); return; }
          draggedPaneId = id;
          setDragging(true);
          e.dataTransfer.setData(PANE_TYPE, id);
          e.dataTransfer.effectAllowed = "move";
          if (TRANSPARENT_DRAG_IMG) e.dataTransfer.setDragImage(TRANSPARENT_DRAG_IMG, 0, 0);
        }}
        onDragEnd={() => { draggedPaneId = null; setDragging(false); }}
      >
        {status && <span className={`ag-dot ${status.dot}`} />}
        <span className="pane-name" title={worker ? nameOf(worker) : undefined}>
          {worker ? <AgentName worker={worker} /> : "Empty — hover to pick an agent"}
        </span>
        {worker && (needsInput
          ? <span className="pane-input-label" title="Needs your input — click the pane to answer">needs input</span>
          : attention
            ? <span className="ag-notify" aria-label="finished with new output" title="finished with new output" />
            : <span className="pane-status">{status.label}</span>)}
        {canClose && (
          <button
            className="pane-close"
            title="Close pane"
            onClick={(e) => { e.stopPropagation(); onClose(); }}
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        )}
      </div>
      {/* Pane-local right panel: the transcript + this pane's docked viewer share
          a horizontal flex row, so an opened panel shrinks ONLY this pane's
          transcript and anchors to this pane's right edge. PaneScopeContext
          publishes the leaf id so a transcript click (and the docked viewers)
          resolve to this pane (see useUi). */}
      <PaneScopeContext.Provider value={id}>
        <div className="pane-body">
          {worker
            // Every split pane is rendered on screen regardless of focus, so all are
            // visible (and may animate); only the focused one is isActive (shared UI).
            ? <Messages live={live} agentId={agentId} isActive={focused} visible={true} />
            : <AgentPickerOverlay live={live} excludeIds={excludeIds} focused={focused} dragActive={!!zone} onPick={onPick} />}
          <PanePanel live={live} />
        </div>
      </PaneScopeContext.Provider>
    </div>
  );
}
