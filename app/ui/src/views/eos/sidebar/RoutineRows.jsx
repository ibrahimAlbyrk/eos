import { useEffect, useState } from "react";
import { refreshRoutines, undeleteRoutine, useRoutines } from "../../../state/eos/routinesStore.js";
import { useInbox } from "../../../state/eos/inboxStore.js";
import { useDevRunSeen } from "../../../state/eos/transport.js";
import { DevRunNote } from "../capabilities/parts.jsx";
import { openLocation } from "../nav/eosNav.js";
import { RoutineRunButton } from "./RoutineRunButton.jsx";

const FILTER_KEY = "eos:sidebarFilter";
// Each filter, the routine states it shows and what it says when none are there.
const FILTERS = {
  active: { label: "Active", states: ["active", "draft"], empty: "No routines yet." },
  paused: { label: "Paused", states: ["paused"], empty: "No paused routines." },
  archived: { label: "Archived", states: ["archived"], empty: "No archived routines." },
  deleted: { label: "Deleted", states: ["deleted"], empty: "Nothing was deleted in the last 30 days." },
};
// Hand runs start in these states; a draft runs only trials.
const RUNNABLE = new Set(["active", "paused"]);

function storedFilter() {
  try {
    const stored = localStorage.getItem(FILTER_KEY);
    return Object.hasOwn(FILTERS, stored ?? "") ? stored : "active";
  } catch {
    return "active";
  }
}

function keepFilter(filter) {
  try { localStorage.setItem(FILTER_KEY, filter); } catch {}
}

// The routine's state as its one status line, and the dot's tone beside it;
// the line always says what the dot shows.
export function routineStatus(routine, waiting) {
  if (routine.state === "paused") return { tone: "warn", line: "Paused" };
  if (routine.state === "archived") return { tone: null, line: "Archived" };
  if (routine.state === "deleted") return { tone: null, line: "Deleted" };
  if (routine.state === "draft") return { tone: null, line: "Being made" };
  if (waiting > 0) return { tone: "active", line: `${waiting} waiting` };
  if (routine.activeRuns > 0) return { tone: "ok", line: "Running" };
  if (routine.lastRun?.state === "failed") return { tone: "err", line: "Last run failed" };
  return { tone: "ok", line: routine.triggerLine ?? "When you run it" };
}

// A routine in Recently deleted has no page to open: only the way back.
function DeletedRow({ routine }) {
  return (
    <li className="eos-side-routine">
      <span className="agents-row eos-side-routine__open">
        <span className="eos-side-dot" aria-hidden="true" />
        <span className="ag-name">{routine.name}</span>
        <span className="eos-side-line">Deleted</span>
      </span>
      <button type="button" className="eos-btn" onClick={() => void undeleteRoutine(routine.id)}>Bring back</button>
    </li>
  );
}

function RoutineRow({ routine, waiting, selected }) {
  if (routine.state === "deleted") return <DeletedRow routine={routine} />;
  const { tone, line } = routineStatus(routine, waiting);
  return (
    <li className="eos-side-routine">
      <button
        type="button"
        className={"agents-row eos-side-routine__open" + (selected ? " on" : "")}
        aria-current={selected ? "page" : undefined}
        onClick={() => openLocation(`eos:/routines/${encodeURIComponent(routine.id)}`)}
      >
        <span className={tone ? `eos-side-dot eos-side-dot--${tone}` : "eos-side-dot"} aria-hidden="true" />
        <span className="ag-name">{routine.name}</span>
        <span className={tone === "active" || tone === "warn" || tone === "err" ? `eos-side-line eos-side-line--${tone}` : "eos-side-line"}>{line}</span>
      </button>
      {RUNNABLE.has(routine.state) && <RoutineRunButton routine={routine} />}
    </li>
  );
}

function FilterChoice({ filter, onChange }) {
  return (
    <div className="eos-seg eos-side-filter" role="radiogroup" aria-label="Show routines">
      {Object.entries(FILTERS).map(([key, f]) => (
        <button key={key} type="button" role="radio" aria-checked={filter === key} className="eos-seg__opt" onClick={() => onChange(key)}>
          {f.label}
        </button>
      ))}
    </div>
  );
}

// The routines under the nav rows, filtered by state, each with its status
// and a Run button.
export function RoutineRows({ selectedId }) {
  const { list, listFailed } = useRoutines();
  const byRoutine = useInbox().list?.counts.byRoutine ?? {};
  const devRun = useDevRunSeen();
  const [filter, setFilter] = useState(storedFilter);
  useEffect(() => { keepFilter(filter); }, [filter]);

  const shown = list?.filter((r) => FILTERS[filter].states.includes(r.state)) ?? [];
  return (
    <section className="agents-section eos-side-routines" aria-label="Routines">
      <div className="sb-seclabel"><span className="sb-seclabel__text">Routines</span></div>
      <FilterChoice filter={filter} onChange={setFilter} />
      {devRun && <DevRunNote />}
      {list === null && listFailed && (
        <p className="eos-side-note" role="alert">
          Couldn&apos;t load routines. <button type="button" className="eos-link" onClick={() => void refreshRoutines()}>Try again</button>
        </p>
      )}
      {list !== null && shown.length === 0 && <p className="eos-side-note">{FILTERS[filter].empty}</p>}
      {shown.length > 0 && (
        <ul className="eos-side-list">
          {shown.map((r) => <RoutineRow key={r.id} routine={r} waiting={byRoutine[r.id] ?? 0} selected={r.id === selectedId} />)}
        </ul>
      )}
    </section>
  );
}
