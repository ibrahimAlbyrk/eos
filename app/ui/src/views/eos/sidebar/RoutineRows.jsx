import { useEffect, useState } from "react";
import { useMenuDismiss } from "../menu/useMenuDismiss.js";
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

// The row's slot holds a short state; a trigger said at length ("When a pull
// request opens") is too long for it, so it says only that it waits for one.
const SLOT = 20;

function RoutineRow({ routine, waiting, selected }) {
  if (routine.state === "deleted") return <DeletedRow routine={routine} />;
  const status = routineStatus(routine, waiting);
  const { tone } = status;
  const line = status.line.length > SLOT && status.line === routine.triggerLine ? "On its trigger" : status.line;
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

// The filter as the design draws it: a quiet icon beside the section's label
// that opens a menu of the four states. A filter other than Active is named
// beside the label, so the list never hides what it leaves out.
function FilterChoice({ filter, onChange }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useMenuDismiss(open, () => setOpen(false));
  const choose = (key) => {
    setOpen(false);
    onChange(key);
  };
  return (
    <span className="eos-menu-wrap eos-side-filter" ref={wrapRef}>
      <button
        type="button"
        className={"sb-seclabel__filter" + (open || filter !== "active" ? " on" : "")}
        aria-label="Filter routines"
        title="Filter routines"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <svg aria-hidden="true" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M3 4.5h10M5 8h6M7 11.5h2" /></svg>
      </button>
      {open && (
        <ul className="eos-menu eos-side-filter__menu" role="menu" aria-label="Show routines" onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}>
          {Object.entries(FILTERS).map(([key, f]) => (
            <li key={key} role="none">
              <button type="button" role="menuitemradio" aria-checked={filter === key} className="eos-menu__item" autoFocus={filter === key} onClick={() => choose(key)}>
                {f.label}
                <span className={"eos-menu__check" + (filter === key ? " on" : "")} aria-hidden="true">✓</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}

// What the list says with nothing under its filter: none at all yet, every
// one paused (with the way to them), or none in this state.
function EmptyNote({ filter, list, onShow }) {
  if (filter === "active" && list.length === 0) {
    return <p className="eos-side-note">No routines yet.<span className="eos-side-note__more">New routine makes the first one from a sentence.</span></p>;
  }
  if (filter === "active" && list.some((r) => r.state === "paused")) {
    return (
      <p className="eos-side-note eos-side-note--warn">
        Every routine is paused. <button type="button" className="eos-link" onClick={() => onShow("paused")}>Show paused</button>
      </p>
    );
  }
  return <p className="eos-side-note">{FILTERS[filter].empty}</p>;
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
      <div className="sb-seclabel">
        <span className="sb-seclabel__text">Routines{filter !== "active" && <span className="eos-side-filter__name"> · {FILTERS[filter].label}</span>}</span>
        <FilterChoice filter={filter} onChange={setFilter} />
      </div>
      {devRun && <DevRunNote />}
      {list === null && !listFailed && (
        <div className="eos-skeleton eos-side-loading" aria-busy="true" aria-label="Loading routines"><span /><span /><span /></div>
      )}
      {list === null && listFailed && (
        <p className="eos-side-note eos-side-note--err" role="alert">
          Couldn&apos;t load routines. <button type="button" className="eos-link" onClick={() => void refreshRoutines()}>Try again</button>
        </p>
      )}
      {list !== null && shown.length === 0 && <EmptyNote filter={filter} list={list} onShow={setFilter} />}
      {shown.length > 0 && (
        <ul className="eos-side-list">
          {shown.map((r) => <RoutineRow key={r.id} routine={r} waiting={byRoutine[r.id] ?? 0} selected={r.id === selectedId} />)}
        </ul>
      )}
    </section>
  );
}
