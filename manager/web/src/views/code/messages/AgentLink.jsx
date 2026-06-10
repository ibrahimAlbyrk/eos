import { useUi } from "../../../state/ui.jsx";

// The one affordance for a name that references another Eos agent: clicking
// selects it. A dead/unknown agent renders as plain text — navigating to a
// deleted id would just bounce the selection back to null.
export function AgentLink({ id, name, workers, className = "ti-file", fallback = "agent" }) {
  const ui = useUi();
  const live = id ? (workers ?? []).find((w) => w.id === id) : null;
  const label = name || live?.name || id || fallback;
  if (!live) return <span className={className}>{label}</span>;
  return (
    <span
      className={(className ? className + " " : "") + "ti-link"}
      onClick={(e) => { e.stopPropagation(); ui.setSelectedId(live.id); }}
    >{label}</span>
  );
}
