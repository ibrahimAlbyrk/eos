import { useEffect, useState } from "react";
import { refreshHome, useHome } from "../../../state/eos/homeStore.js";
import { ensureInboxLoaded, useInbox } from "../../../state/eos/inboxStore.js";
import { ensureRoutinesLoaded, refreshRoutines, useRoutines } from "../../../state/eos/routinesStore.js";
import { open as openRunSheet, useRunSheet } from "../../../state/eos/runSheetStore.js";
import { Loading, LoadFailed } from "../capabilities/parts.jsx";
import { EosHeader } from "../nav/EosHeader.jsx";
import { openLocation } from "../nav/eosNav.js";
import { routineStatus } from "../sidebar/RoutineRows.jsx";
import { kindWord, lastWord, nextWord, rungWord, sortRows, usd } from "./tableWords.js";

const FILTERS = {
  active: { label: "Active", states: ["active", "draft"], empty: "No routines yet. Tell Eos on Home what to take care of." },
  paused: { label: "Paused", states: ["paused"], empty: "No paused routines." },
  archived: { label: "Archived", states: ["archived"], empty: "No archived routines." },
};
const RUNNABLE = new Set(["active", "paused"]);

const COLUMNS = [
  { key: "name", label: "Routine" },
  { key: "kind", label: "Kind", narrow: false },
  { key: "status", label: "Status" },
  { key: "next", label: "Next run" },
  { key: "last", label: "Last result" },
  { key: "waiting", label: "Waiting", numeric: true },
  { key: "cost", label: "This week", numeric: true, narrow: false },
  { key: "rung", label: "Freedom", narrow: false },
];

const Dot = ({ tone }) => <span className={tone ? `eos-dot eos-dot--${tone}` : "eos-dot"} aria-hidden="true" />;

function SortHead({ column, sort, setSort }) {
  const on = sort.key === column.key;
  const flip = () => setSort({ key: column.key, dir: on && sort.dir === "ascending" ? "descending" : "ascending" });
  return (
    <th scope="col" aria-sort={on ? sort.dir : undefined} className={[column.numeric && "eos-rtable__num", column.narrow === false && "eos-rtable__wide"].filter(Boolean).join(" ") || undefined}>
      <button type="button" className="eos-rtable__sort" onClick={flip}>
        {column.label}
        {on && <span aria-hidden="true">{sort.dir === "ascending" ? " ↑" : " ↓"}</span>}
      </button>
    </th>
  );
}

function Row({ row, now, hosted }) {
  const { routine } = row;
  const last = lastWord(routine.lastRun, now);
  const openPage = () => openLocation(`eos:/routines/${encodeURIComponent(routine.id)}`);
  return (
    <tr>
      <th scope="row">
        <button type="button" className="eos-rtable__name" onClick={openPage}>
          <Dot tone={row.tone} />
          {routine.name}
        </button>
      </th>
      <td className="eos-rtable__wide">{kindWord(routine.kind)}</td>
      <td className="eos-rtable__line">{row.line}</td>
      <td>{nextWord(row.nextAt, now) ?? <span className="eos-rtable__none">—</span>}</td>
      <td>{last ? <span className="eos-rtable__last"><Dot tone={last.tone} />{last.text}</span> : <span className="eos-rtable__none">—</span>}</td>
      <td className="eos-rtable__num">{row.waiting > 0 ? row.waiting : <span className="eos-rtable__none">—</span>}</td>
      <td className="eos-rtable__num eos-rtable__wide">{usd(routine.stats?.cost7d) ?? <span className="eos-rtable__none">—</span>}</td>
      <td className="eos-rtable__wide">{rungWord(routine.rung)}</td>
      <td className="eos-rtable__act">
        {hosted > 0 && RUNNABLE.has(routine.state) && (
          <button type="button" className="eos-btn" aria-label={`Run ${routine.name}`} onClick={(e) => openRunSheet({ routineId: routine.id, anchor: e.currentTarget })}>Run</button>
        )}
      </td>
    </tr>
  );
}

// All routines (08 §5): one row each with what it is doing, when it runs
// next, how its last run went, what waits and what it cost this week;
// sorted by any column, filtered by state, each with its Run button.
export function RoutinesScreen() {
  const { list, listFailed } = useRoutines();
  const byRoutine = useInbox().list?.counts.byRoutine ?? {};
  const { next } = useHome();
  const { hosted } = useRunSheet();
  const [filter, setFilter] = useState("active");
  const [sort, setSort] = useState({ key: "name", dir: "ascending" });
  useEffect(() => {
    ensureRoutinesLoaded();
    ensureInboxLoaded();
    void refreshHome();
  }, []);

  const now = Date.now();
  const nextOf = Object.fromEntries(next.filter((n) => n.nextAt != null).map((n) => [n.routineId, n.nextAt]));
  const rows = (list ?? [])
    .filter((r) => FILTERS[filter].states.includes(r.state))
    .map((routine) => {
      const waiting = byRoutine[routine.id] ?? 0;
      return { routine, waiting, nextAt: nextOf[routine.id], ...routineStatus(routine, waiting) };
    });

  return (
    <main className="eos-screen">
      <EosHeader trail={[{ label: "Eos", location: "eos:/" }, { label: "Routines" }]}>
        <button type="button" className="eos-btn eos-btn--primary" onClick={() => openLocation("eos:/routines/new")}>New routine</button>
      </EosHeader>
      <div className="eos-body eos-routines">
        <div className="eos-seg" role="radiogroup" aria-label="Show routines">
          {Object.entries(FILTERS).map(([key, f]) => (
            <button key={key} type="button" role="radio" aria-checked={filter === key} className="eos-seg__opt" onClick={() => setFilter(key)}>{f.label}</button>
          ))}
        </div>
        {list === null && !listFailed && <Loading blocks={4} />}
        {list === null && listFailed && <LoadFailed what="routines" retry={() => void refreshRoutines()} />}
        {list !== null && rows.length === 0 && <p className="eos-note">{FILTERS[filter].empty}</p>}
        {rows.length > 0 && (
          <div className="eos-card eos-rtable-wrap">
            <table className="eos-rtable">
              <thead>
                <tr>
                  {COLUMNS.map((c) => <SortHead key={c.key} column={c} sort={sort} setSort={setSort} />)}
                  <th scope="col"><span className="eos-sr">Run</span></th>
                </tr>
              </thead>
              <tbody>
                {sortRows(rows, sort.key, sort.dir).map((row) => <Row key={row.routine.id} row={row} now={now} hosted={hosted} />)}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
