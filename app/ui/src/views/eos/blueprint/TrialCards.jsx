import { openLocation } from "../nav/eosNav.js";
import { runLocation } from "../routine/RoutineRuns.jsx";
import { hasEnded, stateChip } from "../run/words.js";

// How a trial's mark is drawn: done in ok, failed in err, still going lit.
const TONE = { done: "ok", failed: "err", cancelled: "quiet" };

// The draft's trial runs under the blueprint card, one row each on
// hairlines: its mark, the item, what came of it, and "Read the draft",
// which opens the trial run's view. Nothing a trial makes is ever sent (01 G7).
export function TrialCards({ runs, now }) {
  if (!runs?.length) return null;
  return (
    <section className="eos-bp-trials-wrap" aria-label="Trial">
      <h2 className="eos-label">Trial on {runs.length === 1 ? "one past item" : `${runs.length} past items`}, nothing was sent</h2>
      <ul className="eos-bp-trials">
        {runs.map((run) => (
          <li key={run.id} className={`eos-bp-trial eos-bp-trial--${TONE[run.state] ?? (hasEnded(run) ? "quiet" : "active")}`}>
            <span className="eos-bp-trial__mark" aria-hidden="true" />
            <span className="eos-bp-trial__words">
              <span className="eos-bp-trial__item">{run.itemTitle ?? "Without an item"}</span><span className="eos-bp-trial__line">{run.state === "done" && run.headline ? run.headline : stateChip(run, now).text}</span>
            </span>
            {hasEnded(run) && <button type="button" className="eos-link" onClick={() => openLocation(runLocation(run.id))}>Read the draft</button>}
          </li>
        ))}
      </ul>
    </section>
  );
}
