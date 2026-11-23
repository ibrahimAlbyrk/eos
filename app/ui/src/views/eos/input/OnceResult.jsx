import { useEffect } from "react";
import { dismissOnce, markOnceKept, useOnces } from "../../../state/eos/homeRunsStore.js";
import { keepRoutine } from "../../../state/eos/routinesStore.js";
import { loadRun, loadRunResult, useRuns } from "../../../state/eos/runsStore.js";
import { Loading } from "../capabilities/parts.jsx";
import { DocView } from "../needs/results/ResultView.jsx";
import { buildLocation, openLocation } from "../nav/eosNav.js";
import { runLocation } from "../routine/RoutineRuns.jsx";
import { resultDoc } from "../run/RunView.jsx";
import { hasEnded, reasonLine } from "../run/words.js";

// What the card says under its name while there is no result to show.
export function onceStatus(detail) {
  if (!detail) return "Starting.";
  const { run } = detail;
  if (run.state === "failed") return reasonLine(run);
  if (run.state === "cancelled") return "Stopped.";
  if (!hasEnded(run)) return run.headline ?? "Working on it.";
  return null;
}

function Card({ once }) {
  const { details, results } = useRuns();
  const detail = details[once.runId];
  const done = detail?.run.state === "done";
  const result = results[once.runId];
  useEffect(() => { void loadRun(once.runId); }, [once.runId]);
  useEffect(() => { if (done) void loadRunResult(once.runId); }, [done, once.runId]);
  const status = onceStatus(detail);
  const keep = async () => { if (await keepRoutine(once.routineId)) markOnceKept(once.runId); };
  return (
    <article className="eos-once" aria-label={once.name}>
      <div className="eos-once__head">
        <span className="eos-label">Done once</span>
        <h3 className="eos-once__name">{once.name}</h3>
      </div>
      {status && <p className="eos-once__status" role="status">{status}</p>}
      {done && (result ? <div className="eos-once__result"><DocView doc={resultDoc(result)} /></div> : <Loading blocks={1} />)}
      <div className="eos-once__actions">
        {once.kept ? (
          <button type="button" className="eos-btn eos-btn--primary" onClick={() => openLocation(buildLocation({ screen: "routine", routineId: once.routineId }))}>
            Kept. Open the routine
          </button>
        ) : (
          <button type="button" className="eos-btn eos-btn--primary" disabled={!done} onClick={() => void keep()}>Keep as a routine</button>
        )}
        <button type="button" className="eos-link" onClick={() => openLocation(runLocation(once.runId))}>Open the run</button>
        <span className="eos-input__gap" />
        <button type="button" className="eos-btn eos-btn--quiet" onClick={() => dismissOnce(once.runId)}>Dismiss</button>
      </div>
    </article>
  );
}

// Each task done once from Home (08 G17), its result under the input with
// Keep as a routine and Dismiss; it stays until dismissed.
export function OnceResults() {
  const onces = useOnces();
  if (onces.length === 0) return null;
  return <div className="eos-onces">{onces.map((o) => <Card key={o.runId} once={o} />)}</div>;
}
