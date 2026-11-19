import { openLocation } from "../nav/eosNav.js";
import { runLocation } from "../routine/RoutineRuns.jsx";
import { hasEnded, stateChip } from "../run/words.js";

// The draft's trial runs under the blueprint card, one card each: the item,
// what came of it, and "Read the draft", which opens the trial run's view.
// Nothing a trial makes is ever sent (01 G7).
export function TrialCards({ runs, now }) {
  if (!runs?.length) return null;
  return (
    <section className="eos-routine__section" aria-label="Trial">
      <h2 className="eos-label">Trial on {runs.length === 1 ? "one past item" : `${runs.length} past items`}, nothing was sent</h2>
      <div className="eos-bp-trials">
        {runs.map((run) => (
          <article key={run.id} className="eos-card eos-bp-trial">
            <span className="eos-bp-trial__item">{run.itemTitle ?? "Without an item"}</span>
            <span className="eos-bp-trial__line">{run.state === "done" && run.headline ? run.headline : stateChip(run, now).text}</span>
            {hasEnded(run) && <button type="button" className="eos-link" onClick={() => openLocation(runLocation(run.id))}>Read the draft</button>}
          </article>
        ))}
      </div>
    </section>
  );
}
