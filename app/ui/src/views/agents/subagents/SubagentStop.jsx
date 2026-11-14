import { useSubagentStop } from "../../../state/subagentStopStore.js";

// The Stop control of a running background subagent, in the Jobs tab's look.
export function SubagentStop({ workerId, run }) {
  const { canStop, stopping, stop } = useSubagentStop(workerId, run);
  if (!canStop) return null;
  const click = (e) => {
    e.stopPropagation();
    stop();
  };
  return (
    <button type="button" className="jb-btn is-danger sa-stop" disabled={stopping} onClick={click} aria-label={stopping ? "Stopping subagent" : "Stop subagent"}>
      {stopping ? "Stopping…" : "Stop"}
    </button>
  );
}
