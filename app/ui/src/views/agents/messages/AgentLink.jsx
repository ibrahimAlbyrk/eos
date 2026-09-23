import { useUi } from "../../../state/ui.jsx";
import { AgentName } from "../../../lib/agentName.js";

// The one affordance for a name that references another Eos agent: clicking
// selects it; Cmd-click toggles it as a split pane — identical to a sidebar row
// (AgentsTree). A dead/unknown agent renders as plain text — navigating to a
// deleted id would just bounce the selection back to null.
export function AgentLink({ id, name, workers, className = "ti-file", fallback = "agent", definition }) {
  const ui = useUi();
  const live = id ? (workers ?? []).find((w) => w.id === id) : null;
  const label = name || live?.name || id || fallback;
  // One worker-ish object drives both the name and the muted "(definition)"
  // suffix via the shared <AgentName>. Prefer the live row's definition; fall
  // back to a snapshot value (durable for killed workers off the live list).
  const w = { name: label, is_orchestrator: live?.is_orchestrator, worker_definition: live ? live.worker_definition : definition };
  if (!live) return <span className={className}><AgentName worker={w} /></span>;
  return (
    <span
      className={(className ? className + " " : "") + "ti-link"}
      title="Click to open · Cmd-click to open in a split"
      onClick={(e) => {
        e.stopPropagation();
        if (e.metaKey) ui.togglePaneForAgent(live.id);
        else ui.selectAgent(live.id);
      }}
    ><AgentName worker={w} /></span>
  );
}
