import { useState, useRef, useEffect } from "react";
import { useUi } from "../../../state/ui.jsx";
import { statusFromState } from "../../../lib/format.js";
import { nameOf } from "../../../lib/agentName.js";
import { useInputNeeded } from "../../../hooks/useInputNeeded.js";
import { Messages } from "../messages/Messages.jsx";

// Split view: lay out the active panes as a grid of live transcripts. Each pane
// renders ONE agent via the same <Messages> the keep-alive host uses (agentId +
// isActive). Only the focused pane is isActive, so only it drives the shared UI
// (question banner, verdict, ⌘F, agent viewer) — the others stay visible but
// silent. Focus follows a pointer-down anywhere in the pane; the header + the
// shared composer below track the focused pane's agent (= global selectedId).

// grid-template-areas slot per pane index (see .pane-grid.count-N in styles.css).
const AREAS = ["a", "b", "c", "d"];

export function PaneGrid({ live }) {
  const ui = useUi();
  const count = ui.paneCount;
  // Own enable switch, independent of the sidebar activity indicators (default
  // on). Uses needsAttentionRaw so toggling sidebar indicators off doesn't also
  // silence pane pulses.
  const pulseOn = ui.settings?.["notifications.paneAttention"] !== false;

  // Resizable splits — local geometry (not part of the agent model), persisted.
  // col drives the vertical split (all layouts); row the horizontal (count >= 3).
  // minmax(0, …) kept so a wide transcript line can't force a horizontal scrollbar.
  const gridRef = useRef(null);
  const [col, setCol] = useState(() => loadRatio("cm:paneCol"));
  const [row, setRow] = useState(() => loadRatio("cm:paneRow"));
  useEffect(() => { localStorage.setItem("cm:paneCol", String(col)); }, [col]);
  useEffect(() => { localStorage.setItem("cm:paneRow", String(row)); }, [row]);
  const gridStyle = {
    gridTemplateColumns: `minmax(0, ${col}fr) minmax(0, ${1 - col}fr)`,
    ...(count >= 3 ? { gridTemplateRows: `minmax(0, ${row}fr) minmax(0, ${1 - row}fr)` } : null),
  };

  return (
    <div className={`pane-grid count-${count}`} style={gridStyle} ref={gridRef}>
      {ui.paneAgents.map((id, i) => {
        const worker = id ? live.workers.find((w) => w.id === id) ?? null : null;
        const focused = i === ui.focusedPane;
        return (
          <Pane
            key={i}
            index={i}
            agentId={id}
            worker={worker}
            live={live}
            focused={focused}
            // A non-focused pane whose agent finished a turn with unseen output
            // pulses to draw the eye; focusing it marks it viewed (clears).
            attention={pulseOn && !focused && !!worker && ui.needsAttentionRaw(worker)}
            canClose={count > 1}
            onFocus={() => ui.focusPane(i)}
            onClose={() => ui.closePane(i)}
            onDropAgent={(agentId) => ui.dropAgentOnPane(i, agentId)}
          />
        );
      })}
      <PaneDividers count={count} col={col} row={row} setCol={setCol} setRow={setRow} gridRef={gridRef} />
    </div>
  );
}

function loadRatio(key) {
  const v = parseFloat(localStorage.getItem(key) ?? "0.5");
  return Number.isFinite(v) && v >= 0.2 && v <= 0.8 ? v : 0.5;
}

// Absolute drag handles overlaid on the grid gaps. Pointer-capture drag (the
// EffortPopover idiom): pointerdown captures, pointermove updates the ratio while
// the button is held (capture auto-releases on up); double-click resets to 0.5.
function PaneDividers({ count, col, row, setCol, setRow, gridRef }) {
  const start = (e) => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); };
  const drag = (axis) => (e) => {
    if (!(e.buttons & 1)) return;
    const rect = gridRef.current?.getBoundingClientRect();
    if (!rect) return;
    const raw = axis === "col" ? (e.clientX - rect.left) / rect.width : (e.clientY - rect.top) / rect.height;
    const r = Math.min(0.8, Math.max(0.2, raw));
    (axis === "col" ? setCol : setRow)(r);
  };
  return (
    <>
      <div
        className="pane-divider pane-divider--v"
        style={{ left: `${col * 100}%` }}
        onPointerDown={start}
        onPointerMove={drag("col")}
        onDoubleClick={() => setCol(0.5)}
      />
      {count >= 3 && (
        <div
          className="pane-divider pane-divider--h"
          // count-3: the divider only splits the right column (a spans both rows).
          style={{ top: `${row * 100}%`, left: count === 3 ? `${col * 100}%` : 0, right: 0 }}
          onPointerDown={start}
          onPointerMove={drag("row")}
          onDoubleClick={() => setRow(0.5)}
        />
      )}
    </>
  );
}

function Pane({ index, agentId, worker, live, focused, attention, canClose, onFocus, onClose, onDropAgent }) {
  // Blocked-on-input cue for non-focused panes: an open ask_user question
  // (per-agent store) or a pending permission (live.pendingPermissions). The
  // focused pane needs none — its banner is in the shared composer.
  const questionNeeded = useInputNeeded(agentId);
  const [dragOver, setDragOver] = useState(false);
  const permNeeded = !!worker && (live.pendingPermissions ?? []).some((p) => p.worker_id === agentId);
  const needsInput = !focused && !!worker && (questionNeeded || permNeeded);
  const status = worker ? statusFromState(worker.state) : null;
  // needs-input takes precedence over the attention pulse (more urgent) — both
  // pulse the edge, in warn vs accent. drag-over overrides both (it's a momentary
  // drop cue; .pane-grid .pane.drag-over wins on specificity).
  const cls = ["pane", focused ? "is-focused" : "", needsInput ? "pane--needs-input" : attention ? "pane--attention" : "", dragOver ? "drag-over" : ""]
    .filter(Boolean)
    .join(" ");

  const hasAgentDrag = (e) => e.dataTransfer.types.includes("application/x-eos-agent");

  return (
    <div
      className={cls}
      style={{ gridArea: AREAS[index] }}
      // Capture so a click that also hits a transcript link/button still focuses
      // the pane first. mousedown (not click) makes focus feel immediate.
      onMouseDownCapture={focused ? undefined : onFocus}
      onDragOver={(e) => {
        if (!hasAgentDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (!dragOver) setDragOver(true);
      }}
      // contains(relatedTarget): ignore leaves into the pane's own children
      // (otherwise the highlight flickers as the pointer crosses the transcript).
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(false); }}
      onDrop={(e) => {
        setDragOver(false);
        const id = e.dataTransfer.getData("application/x-eos-agent");
        if (id) { e.preventDefault(); onDropAgent(id); }
      }}
    >
      <div className="pane-head">
        {status && <span className={`ag-dot ${status.dot}`} />}
        <span className="pane-name" title={worker ? nameOf(worker) : undefined}>
          {worker ? nameOf(worker) : "Empty — pick an agent in the sidebar"}
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
      <Messages live={live} agentId={agentId} isActive={focused} />
    </div>
  );
}
