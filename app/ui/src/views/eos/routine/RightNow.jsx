import { openLocation } from "../nav/eosNav.js";
import { hasEnded, stateChip } from "../run/words.js";
import { runLocation } from "./RoutineRuns.jsx";

// Right now: the routine's runs that have not ended, each with its state and
// the way to it. Item titles come from outside: React text only.
export function RightNow({ runs, now }) {
  const live = runs.filter((r) => !hasEnded(r));
  return (
    <section className="eos-routine__section eos-routine__now" aria-label="Right now">
      <h2 className="eos-label">Right now</h2>
      {live.length === 0 ? (
        <p className="eos-note">Nothing is running.</p>
      ) : (
        <ul className="eos-runs">
          {live.map((r) => {
            const chip = stateChip(r, now);
            return (
              <li key={r.id} className="eos-run-row eos-run-row__open">
                <span className="eos-run-row__title">{r.itemTitle ?? "Run"}</span>
                <span className="eos-run-row__line"><span className={chip.tone ? `eos-status eos-status--${chip.tone}` : "eos-status"}>{chip.text}</span></span>
                <button type="button" className="eos-link" onClick={() => openLocation(runLocation(r.id))}>Open the run</button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
