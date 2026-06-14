import { useUi } from "../../../state/ui.jsx";
import { statusFromState } from "../../../lib/format.js";
import { nameOf } from "../../../lib/agentName.js";
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
  return (
    <div className={`pane-grid count-${ui.paneCount}`}>
      {ui.paneAgents.map((id, i) => (
        <Pane
          key={i}
          index={i}
          agentId={id}
          live={live}
          focused={i === ui.focusedPane}
          canClose={ui.paneCount > 1}
          onFocus={() => ui.focusPane(i)}
          onClose={() => ui.closePane(i)}
        />
      ))}
    </div>
  );
}

function Pane({ index, agentId, live, focused, canClose, onFocus, onClose }) {
  const worker = agentId ? live.workers.find((w) => w.id === agentId) : null;
  const status = worker ? statusFromState(worker.state) : null;

  return (
    <div
      className={"pane" + (focused ? " is-focused" : "")}
      style={{ gridArea: AREAS[index] }}
      // Capture so a click that also hits a transcript link/button still focuses
      // the pane first. mousedown (not click) makes focus feel immediate.
      onMouseDownCapture={focused ? undefined : onFocus}
    >
      <div className="pane-head">
        {status && <span className={`ag-dot ${status.dot}`} />}
        <span className="pane-name" title={worker ? nameOf(worker) : undefined}>
          {worker ? nameOf(worker) : "Empty — pick an agent in the sidebar"}
        </span>
        {worker && <span className="pane-status">{status.label}</span>}
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
