import { useState } from "react";
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
  // Own enable switch, independent of the sidebar activity indicators (default
  // on). Uses needsAttentionRaw so toggling sidebar indicators off doesn't also
  // silence pane pulses.
  const pulseOn = ui.settings?.["notifications.paneAttention"] !== false;
  return (
    <div className={`pane-grid count-${ui.paneCount}`}>
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
            canClose={ui.paneCount > 1}
            onFocus={() => ui.focusPane(i)}
            onClose={() => ui.closePane(i)}
            onDropAgent={(agentId) => ui.dropAgentOnPane(i, agentId)}
          />
        );
      })}
    </div>
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
