import { useUi } from "../../../state/ui.jsx";

// The one affordance for a name that references another Eos agent: clicking
// selects it; Cmd-click toggles it as a split pane — identical to a sidebar row
// (AgentsTree). A dead/unknown agent renders as plain text — navigating to a
// deleted id would just bounce the selection back to null.
export function AgentLink({ id, name, workers, className = "ti-file", fallback = "agent" }) {
  const ui = useUi();
  const live = id ? (workers ?? []).find((w) => w.id === id) : null;
  const label = name || live?.name || id || fallback;
  if (!live) return <span className={className}>{label}</span>;
  return (
    <span
      className={(className ? className + " " : "") + "ti-link"}
      title="Click to open · Cmd-click to open in a split"
      onClick={(e) => {
        e.stopPropagation();
        if (e.metaKey) ui.togglePaneForAgent(live.id);
        else ui.selectAgent(live.id);
      }}
    >{label}</span>
  );
}
