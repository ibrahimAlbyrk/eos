import { useState, useRef } from "react";
import { useUi } from "../../../state/ui.jsx";
import { useInputNeeded } from "../../../hooks/useInputNeeded.js";
import { computeRects, computeDividers, dropZoneFromPoint, MAX_PANES } from "../../../lib/paneLayout.js";
import { usePaneTransitions } from "../../../hooks/usePaneTransitions.js";
import { Messages } from "../messages/Messages.jsx";
import { TranscriptHost } from "../messages/TranscriptHost.jsx";
import { Composer } from "../center/Composer.jsx";
import { DragAffordance } from "./DragAffordance.jsx";
import { PaneHeader } from "./PaneHeader.jsx";
import { SidePanel } from "./SidePanel.jsx";
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

// Split view: a BSP tree (ui.tree) rendered as a FLAT set of absolutely-
// positioned panes (computeRects) + one divider per split (computeDividers).
// Panes are keyed by leaf id, decoupled from the tree's nesting, so a structural
// edit (split/close) never remounts a surviving pane — only its rect moves
// (keep-alive). Each pane renders ONE agent via the shared <Messages>; only the
// focused pane is isActive and drives the shared UI. Each pane owns its OWN right
// side panel (rendered beside its transcript column, scoped to the pane), so it
// opens/closes/resizes independently of the other panes.
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
    return (
      <div
        key={id}
        ref={isLeaving ? setNode(id) : undefined}
        className={"pane-slot" + (isLeaving ? " is-leaving" : "")}
        style={pctStyle(rect)}
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
  return (
    <div className="single-pane" {...handlers}>
      {zone && <DropPreview zone={zone} />}
      {zone && pointer && <DragAffordance pointer={pointer} zone={zone} />}
      {/* Transcript + composer stack on the left, this pane's own side panel on
          the right (null when closed). Both share the pane scope so the header's
          Open-side-panel / Environment actions and the panel resolve to it. The
          region handlers claim ⌘F for the transcript vs the panel. */}
      <PaneScopeContext.Provider value={leafId}>
        <div className="sp-main" onMouseDownCapture={() => ui.setFocusedRegion("transcript")}>
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
        </div>
        <SidePanel live={live} />
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
      {/* Header + body + panel share ONE pane scope: the header's split/menu, the
          composer's actions and this pane's side panel all resolve to THIS pane,
          zero prop-drilling. The transcript column and the panel sit side by side
          (the panel is a no-op null when this pane's panel is closed). */}
      <PaneScopeContext.Provider value={id}>
        <div className="pane-col">
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
        </div>
        <SidePanel live={live} />
      </PaneScopeContext.Provider>
    </div>
  );
}
