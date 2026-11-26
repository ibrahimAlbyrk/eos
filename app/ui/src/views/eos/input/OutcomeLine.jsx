import { useRuns } from "../../../state/eos/runsStore.js";
import { DEV_RUN_TEXT } from "../capabilities/parts.jsx";
import { openLocation } from "../nav/eosNav.js";
import { runLocation } from "../routine/RoutineRuns.jsx";
import { isLive, repeatLine } from "../runform/runFormModel.js";

const OFFLINE_TEXT = "Eos isn't reachable. Try again in a moment.";

// What a refused act says in the intent line's place (08 G15, G36): the
// same item handled lately, with Run again (↵), or a run of it still at
// work, shown first; a dev run, no core, or the core's own words.
export function OutcomeLine({ outcome, again }) {
  const { details } = useRuns();
  if (outcome.repeat) {
    const earlier = details[outcome.repeat];
    const live = earlier ? isLive(earlier) : false;
    const text = earlier ? repeatLine(outcome.routine, earlier, Date.now()) : `${outcome.routine.name} handled this item lately.`;
    return (
      <div className="eos-intent__line" role="status">
        {!live && <span className="eos-intent__key" aria-hidden="true">↵</span>}
        <span className="eos-intent__text">{text}</span>
        {live && <button type="button" className="eos-btn eos-btn--primary" onClick={() => openLocation(runLocation(outcome.repeat))}>Open the run</button>}
        <button type="button" className="eos-btn" onClick={again}>{live ? "Run again anyway" : "Run again"}</button>
      </div>
    );
  }
  const text = outcome.devRun ? DEV_RUN_TEXT : outcome.offline ? OFFLINE_TEXT : outcome.error;
  return (
    <div className="eos-intent__line" role="alert">
      <span className="eos-intent__text eos-intent__text--note">{text}</span>
    </div>
  );
}
