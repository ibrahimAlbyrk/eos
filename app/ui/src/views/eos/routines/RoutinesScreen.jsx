import { useEffect, useState } from "react";
import { refreshHome, useHome } from "../../../state/eos/homeStore.js";
import { ensureInboxLoaded, useInbox, waitingByRoutine } from "../../../state/eos/inboxStore.js";
import { ensureRoutinesLoaded, refreshRoutines, useRoutines } from "../../../state/eos/routinesStore.js";
import { open as openRunSheet, useRunSheet } from "../../../state/eos/runSheetStore.js";
import { LoadingRows } from "../capabilities/parts.jsx";
import { FailedLead } from "../frame.jsx";
import { ComingUp } from "../home/ComingUp.jsx";
import { comingUp } from "../home/homeWords.js";
import { RoutineGlyph } from "./RoutineGlyph.jsx";
import { RoutinesFirst } from "./RoutinesFirst.jsx";
import { RoutinesResting } from "./RoutinesResting.jsx";
import { EosHeader } from "../nav/EosHeader.jsx";
import { openLocation } from "../nav/eosNav.js";
import { routineStatus } from "../sidebar/RoutineRows.jsx";
import { kindWord, lastWord, nextWord, routinesLead, rungWord, sharedRung, soonestLine, sortRows, statusWords, usd } from "./tableWords.js";

const FILTERS = {
  active: { label: "Active", states: ["active", "draft"] },
  paused: { label: "Paused", states: ["paused"], empty: "No paused routines.", text: "A routine you pause waits here, with what it learned, until you start it again." },
  archived: { label: "Archived", states: ["archived"], empty: "No archived routines.", text: "A routine you archive keeps its runs and what it learned here, out of the way." },
};
const RUNNABLE = new Set(["active", "paused"]);

const namesOf = (list) => Object.fromEntries((list ?? []).map((r) => [r.id, r.name]));

const COLUMNS = [
  { key: "name", label: "Routine" },
  { key: "status", label: "Status" },
  { key: "next", label: "Next run" },
  { key: "last", label: "Last result", mid: true },
  { key: "cost", label: "This week", numeric: true, narrow: false },
];

// What sits beside a routine's name: its freedom, and its kind when it is not
// the usual standing one. Said once per row instead of as two columns that
// repeat the same words down the table.
// The freedom most rows share is said once in the lead, so a row says only one that differs.
const contextOf = (routine, shared) => [routine.kind !== "standing" && kindWord(routine.kind), routine.rung !== shared && rungWord(routine.rung)].filter(Boolean).join(" · ");

const Dot = ({ tone }) => <span className={tone ? `eos-dot eos-dot--${tone}` : "eos-dot"} aria-hidden="true" />;

// The active routines grouped by what the user must do: those waiting for
// them (or whose last run failed), those running with nothing waiting (never
// "on their own": a routine that drafts for the user is not), those being
// made. Paused and archived are one group each, unnamed. A group with no
// routine is left out.
const GROUPS = [
  { key: "you", label: "Waiting for you", has: (r) => r.waiting > 0 || r.tone === "err" },
  { key: "own", label: "Nothing waiting", has: (r) => r.routine.state === "active" },
  { key: "made", label: "Being made", has: (r) => r.routine.state === "draft" },
];
function groupsOf(rows, filter) {
  if (filter !== "active") return [{ key: filter, rows }];
  const left = new Set(rows);
  return GROUPS.map((g) => {
    const members = rows.filter((r) => left.has(r) && g.has(r));
    members.forEach((r) => left.delete(r));
    return { ...g, rows: members };
  }).filter((g) => g.rows.length > 0);
}

function SortHead({ column, sort, setSort }) {
  const on = sort.key === column.key;
  const flip = () => setSort({ key: column.key, dir: on && sort.dir === "ascending" ? "descending" : "ascending" });
  return (
    <th scope="col" aria-sort={on ? sort.dir : undefined} className={[column.numeric && "eos-rtable__num", column.narrow === false && "eos-rtable__wide", column.mid && "eos-rtable__mid"].filter(Boolean).join(" ") || undefined}>
      <button type="button" className="eos-rtable__sort" onClick={flip}>
        {column.label}
        {on && <span aria-hidden="true">{sort.dir === "ascending" ? " ↑" : " ↓"}</span>}
      </button>
    </th>
  );
}

function Row({ row, now, hosted, shared }) {
  const { routine } = row;
  const last = lastWord(routine.lastRun, now);
  const openPage = () => openLocation(`eos:/routines/${encodeURIComponent(routine.id)}`);
  return (
    <tr>
      <th scope="row">
        <button type="button" className="eos-rtable__name" onClick={openPage}>
          <span className={row.tone ? `eos-rtable__mark eos-rtable__mark--${row.tone}` : "eos-rtable__mark"} aria-hidden="true">
            <RoutineGlyph icon={routine.icon} name={routine.name} size={14} part="eos-rtable" />
          </span>
          <span className="eos-rtable__words">
            <span className="eos-rtable__head">
              <span className="eos-rtable__title">{routine.name}</span>
              {contextOf(routine, shared) && <span className="eos-rtable__ctx">{contextOf(routine, shared)}</span>}
            </span>
            {routine.summary && <span className="eos-rtable__summary">{routine.summary}</span>}
          </span>
        </button>
      </th>
      <td className={row.tone ? `eos-rtable__line eos-rtable__line--${row.tone}` : "eos-rtable__line"}>{statusWords(row)}</td>
      <td>{nextWord(row.nextAt, now) ?? <span className="eos-rtable__none">—</span>}</td>
      <td className="eos-rtable__mid">{last ? <span className="eos-rtable__last"><Dot tone={last.tone} />{last.text}</span> : <span className="eos-rtable__none">—</span>}</td>
      <td className="eos-rtable__num eos-rtable__wide">{usd(routine.stats?.cost7d) ?? <span className="eos-rtable__none">—</span>}</td>
      <td className="eos-rtable__act">
        {hosted > 0 && RUNNABLE.has(routine.state) && (
          <button type="button" className="eos-btn eos-btn--quiet" aria-label={`Run ${routine.name}`} onClick={(e) => openRunSheet({ routineId: routine.id, anchor: e.currentTarget })}>Run</button>
        )}
      </td>
    </tr>
  );
}

// All routines (08 §5): one row each with its freedom, what it is doing (what
// waits, in its tone), when it runs next, how its last run went and what it
// cost this week;
// sorted by any column, filtered by state, each with its Run button.
export function RoutinesScreen() {
  const { list, listFailed } = useRoutines();
  const byRoutine = waitingByRoutine(useInbox().list);
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
    // A paused routine with something waiting is among the active, as in the
    // sidebar: what it holds needs the user now.
    .filter((r) => FILTERS[filter].states.includes(r.state) || (filter === "active" && r.state === "paused" && (byRoutine[r.id] ?? 0) > 0))
    .map((routine) => {
      const waiting = byRoutine[routine.id] ?? 0;
      return { routine, waiting, nextAt: nextOf[routine.id], ...routineStatus(routine, waiting) };
    });

  // No routines at all: no filters to choose, just how one begins.
  const none = list !== null && list.length === 0;
  // Some routines, none of them active: a first step back instead of an empty tab.
  const shared = sharedRung(rows);
  const resting = list !== null && list.length > 0 && filter === "active" && rows.length === 0;
  const failed = list === null && listFailed;
  return (
    <main className={none || resting || failed ? "eos-screen eos-screen--read" : "eos-screen eos-screen--wide"}>
      <EosHeader trail={[{ label: "Routines" }]}>
        {/* While the list failed, Try again is the one primary act. */}
        <button type="button" className={failed ? "eos-btn" : "eos-btn eos-btn--primary"} onClick={() => openLocation("eos:/routines/new")}>New routine</button>
      </EosHeader>
      <div className="eos-body eos-routines">
        {list !== null && !resting && (list.length > 0 || filter !== "active") && (
          <header className="eos-routines__head">
            <p className="eos-lead">{rows.length > 0 ? routinesLead(rows) : FILTERS[filter].empty}</p>
            {rows.length === 0 && <p className="eos-lead__sub">{FILTERS[filter].text}</p>}
            {shared && <p className="eos-rlead__now">{shared.line}</p>}
            {filter !== "active" && soonestLine(rows, now) && <p className="eos-lead__sub">{soonestLine(rows, now)}</p>}
          </header>
        )}
        {filter === "active" && rows.length > 0 && <ComingUp slots={comingUp(next, now)} names={namesOf(list)} now={now} />}
        {list !== null && !none && !resting && <div className="eos-seg" role="radiogroup" aria-label="Show routines">
          {Object.entries(FILTERS).map(([key, f]) => (
            <button key={key} type="button" role="radio" aria-checked={filter === key} className="eos-seg__opt" onClick={() => setFilter(key)}>{f.label}</button>
          ))}
        </div>}
        {list === null && !listFailed && <LoadingRows rows={4} />}
        {failed && <FailedLead what="routines" retry={() => void refreshRoutines()} />}
        {resting && <RoutinesResting list={list} showArchived={() => setFilter("archived")} />}
        {none && <RoutinesFirst />}
        {rows.length > 0 && (
          <div className="eos-rtable-wrap">
            <table className="eos-rtable">
              <thead>
                <tr>
                  {COLUMNS.map((c) => <SortHead key={c.key} column={c} sort={sort} setSort={setSort} />)}
                  <th scope="col"><span className="eos-sr">Run</span></th>
                </tr>
              </thead>
              {groupsOf(rows, filter).map((g) => (
                <tbody key={g.key} className="eos-rtable__group">
                  {g.label && (
                    <tr className="eos-rtable__grouphead">
                      <th scope="colgroup" colSpan={COLUMNS.length + 1}>
                        <span className="eos-label">{g.label}</span>
                        <span className="eos-section__aside">{g.rows.length}</span>
                      </th>
                    </tr>
                  )}
                  {sortRows(g.rows, sort.key, sort.dir).map((row) => <Row key={row.routine.id} row={row} now={now} hosted={hosted} shared={shared?.rung} />)}
                </tbody>
              ))}
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
