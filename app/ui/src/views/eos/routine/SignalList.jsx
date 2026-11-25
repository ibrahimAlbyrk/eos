import { useEffect } from "react";
import { fmtTimeAgo } from "../../../lib/format.js";
import { listKey, loadSignals, replaySignals, setSignalFilter, useSignals } from "../../../state/eos/signalsStore.js";
import { LoadFailed, LoadingRows } from "../capabilities/parts.jsx";
import { EmptyState } from "../frame.jsx";
import { openLocation } from "../nav/eosNav.js";
import { runLocation } from "./RoutineRuns.jsx";
import { canRunAnyway, decisionLine, decisionTone, replayLine, RUN_THEM, SIGNAL_FILTERS, signalsCount } from "./words.js";

function DecisionFilter({ decision, onChange }) {
  return (
    <div className="eos-seg" role="radiogroup" aria-label="Show signals">
      {SIGNAL_FILTERS.map(([key, label]) => (
        <button key={key || "all"} type="button" role="radio" aria-checked={decision === key} className="eos-seg__opt" onClick={() => onChange(key)}>
          {label}
        </button>
      ))}
    </div>
  );
}

// One signal: its item, what happened and when, what became of it for this
// routine, and Run it anyway for one that started no run. Item titles and
// subjects come from outside: React text only.
function SignalRow({ signal, routineId, replay, now }) {
  const decision = signal.decisions.find((d) => d.routineId === routineId);
  return (
    <li className="eos-signal">
      <span className="eos-signal__main">
        <span className="eos-signal__title">{signal.item.title ?? signal.subject}</span>
        <span className="eos-signal__line">{signal.kind} · {fmtTimeAgo(signal.receivedAt, now)}</span>
      </span>
      <span className="eos-signal__side">
        <span data-tone={decisionTone(decision)} className="eos-signal__decision">{decision ? decisionLine(decision) : "Not decided yet"}</span>
        {decision?.runId && <button type="button" className="eos-btn eos-btn--quiet" onClick={() => openLocation(runLocation(decision.runId))}>Open the run</button>}
        {decision && canRunAnyway(decision) && !replay && (
          <button type="button" className="eos-btn eos-btn--quiet" onClick={() => void replaySignals(routineId, [signal.id])}>Run it anyway</button>
        )}
        {replay && <span className="eos-signal__replay" role="status">{replayLine(replay)}</span>}
      </span>
    </li>
  );
}

// The Signals tab (02 §8): what came for the routine, newest first, by
// decision; the over-limit, paused and baseline groups can be run at once.
export function SignalList({ routineId }) {
  const { lists, replays, filters } = useSignals();
  const decision = filters[routineId] ?? "";
  // Read once when the tab opens; a filter reads its own list.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void loadSignals(routineId, decision || undefined); }, [routineId]);

  const list = lists[listKey(routineId, decision || undefined)];
  const now = Date.now();
  const waiting = list?.rows?.filter((s) => !replays[s.id]).map((s) => s.id) ?? [];
  return (
    <section className="eos-routine__section" aria-label="What came for it">
      <div className="eos-routine__head">
        <h2 className="eos-label">What came for it</h2>
        {list?.rows?.length > 0 && <span className="eos-section__aside">{signalsCount(list.rows, routineId)}</span>}
      </div>
      <DecisionFilter decision={decision} onChange={(next) => void setSignalFilter(routineId, next)} />
      {!list && <LoadingRows rows={4} />}
      {list?.failed && <LoadFailed what="signals" retry={() => void loadSignals(routineId, decision || undefined)} />}
      {list?.rows?.length === 0 && (decision
        ? <EmptyState title="None in this group.">Pick All to see everything that came for it.</EmptyState>
        : <EmptyState title="Nothing came for it yet.">A signal is something one of its sources saw, like a pull request that opened. Each one shows here with what the routine did with it.</EmptyState>)}
      {list?.rows?.length > 0 && (
        <>
          {RUN_THEM.has(decision) && waiting.length > 0 && (
            <div className="eos-actions">
              <button type="button" className="eos-btn eos-btn--primary" onClick={() => void replaySignals(routineId, waiting)}>Run them</button>
            </div>
          )}
          <ul className="eos-signals">
            {list.rows.map((s) => <SignalRow key={s.id} signal={s} routineId={routineId} replay={replays[s.id]} now={now} />)}
          </ul>
        </>
      )}
    </section>
  );
}
