import { useInbox } from "../../../state/eos/inboxStore.js";
import { routineStatus } from "../sidebar/RoutineRows.jsx";

// The routine's state in words with its dot, as its sidebar row says it.
export function StatusChip({ routine }) {
  const waiting = useInbox().list?.counts.byRoutine[routine.id] ?? 0;
  const { tone, line } = routineStatus(routine, waiting);
  return <span className={tone ? `eos-status eos-status--${tone}` : "eos-status"}>{line}</span>;
}
