import { useEffect } from "react";
import { ensureRunsLoaded, useRuns } from "../../../state/eos/runsStore.js";
import { openLocation } from "../nav/eosNav.js";
import { RunRow } from "../routine/RoutineRuns.jsx";

// How many of the routine's other runs the run page names.
const SHOWN = 4;

// Under a run: its routine's latest other runs, so one run reads as one of
// many (better, worse, as usual) and the page ends on where to go next.
// Nothing while they load or when there are none.
export function RunNeighbours({ run, routineName, now }) {
  const page = useRuns().pages[run.routineId];
  useEffect(() => { ensureRunsLoaded(run.routineId); }, [run.routineId]);
  const others = (page?.runs ?? []).filter((r) => r.id !== run.id).slice(0, SHOWN);
  if (others.length === 0) return null;
  return (
    <section className="eos-run-neighbours" aria-labelledby="eos-run-neighbours">
      <header className="eos-section__head">
        <h2 id="eos-run-neighbours" className="eos-label">{routineName ? `${routineName}'s other runs` : "Its other runs"}</h2>
        <button type="button" className="eos-link eos-section__aside" onClick={() => openLocation(`eos:/routines/${encodeURIComponent(run.routineId)}?tab=runs`)}>
          Every run
        </button>
      </header>
      <ul className="eos-runs">{others.map((r) => <RunRow key={r.id} run={r} now={now} />)}</ul>
    </section>
  );
}
