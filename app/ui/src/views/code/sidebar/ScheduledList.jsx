import { useEffect, useSyncExternalStore } from "react";
import { useUi } from "../../../state/ui.jsx";
import { useClockTick } from "../../../hooks/useClockTick.js";
import { subscribe, itemsFor, refreshScheduled } from "../../../state/scheduledStore.js";
import { relativeUntil, formatFireAt } from "../../../lib/scheduleTime.js";

const STATUS_LABEL = { pending: "bekliyor", fired: "gönderildi", cancelled: "iptal" };

// One scheduled-prompt row (RunsList's wf-run-row shape): single-line ellipsized
// preview + a time/status meta cluster. Pending rows count down; past rows show
// the wall-clock moment they fired (or were due).
function SchedRow({ row, now }) {
  const time = row.status === "pending" ? relativeUntil(row.fireAt, now) : formatFireAt(row.firedAt ?? row.fireAt);
  return (
    <div className="sched-row">
      <span className="sched-row__text">{row.text}</span>
      <span className="sched-row__meta">
        <span className="sched-row__time">{time}</span>
        <span className={"sched-chip sched-chip--" + row.status}>{STATUS_LABEL[row.status] ?? row.status}</span>
      </span>
    </div>
  );
}

// Upcoming/Past scheduled prompts for the selected agent, shown as its own
// sidebar island. Renders nothing until there's a selection with at least one
// row, so the sidebar stays clean for agents that have none.
export function ScheduledList() {
  const ui = useUi();
  const workerId = ui.selectedId;
  const now = useClockTick();

  const rows = useSyncExternalStore(subscribe, () => itemsFor(workerId));
  useEffect(() => { if (workerId) refreshScheduled(workerId); }, [workerId]);

  if (!workerId || rows.length === 0) return null;

  const upcoming = rows.filter((r) => r.status === "pending").sort((a, b) => a.fireAt - b.fireAt);
  const past = rows
    .filter((r) => r.status !== "pending")
    .sort((a, b) => (b.firedAt ?? b.fireAt) - (a.firedAt ?? a.fireAt));

  return (
    <div className="side-island scheduled-island">
      <div className="scheduled-sec-title">Zamanlanmış{upcoming.length ? ` (${upcoming.length})` : ""}</div>
      {upcoming.map((r) => <SchedRow key={r.id} row={r} now={now} />)}
      {past.length > 0 && (
        <>
          <div className="scheduled-sec-title scheduled-sec-title--past">Geçmiş</div>
          {past.map((r) => <SchedRow key={r.id} row={r} now={now} />)}
        </>
      )}
    </div>
  );
}
