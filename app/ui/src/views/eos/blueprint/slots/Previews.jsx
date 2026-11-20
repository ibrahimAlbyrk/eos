import { useEffect } from "react";
import { loadSchedulePreview, loadWhichPreview, scheduleKey, useSignals, whichKey } from "../../../../state/eos/signalsStore.js";
import { ruleName, timeAt } from "../../routine/words.js";

// How many next times the When preview shows per schedule…
const NEXT_SHOWN = 3;
// …and how many of the routine's latest signals the Which preview tries.
const WHICH_TRIED = 50;

function NextTimes({ schedule }) {
  const key = scheduleKey(schedule, NEXT_SHOWN);
  const answer = useSignals().previews[key];
  // `key` stands for the schedule.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void loadSchedulePreview(schedule, NEXT_SHOWN); }, [key]);
  if (!answer?.next?.length) return null;
  return <p className="eos-bp-preview">Next: {answer.next.map(timeAt).join(", ")}</p>;
}

// Beside the When slot: the next times of each schedule.
export function SchedulePreview({ when }) {
  const schedules = (when?.on ?? []).filter((t) => t.schedule).map((t) => t.schedule);
  return schedules.map((s, n) => <NextTimes key={n} schedule={s} />);
}

const signals = (n) => `${n} ${n === 1 ? "signal" : "signals"}`;

function WhichAnswer({ routineId, which }) {
  const key = whichKey(routineId, which, WHICH_TRIED);
  const answer = useSignals().previews[key];
  // `key` stands for the routine and the Which.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void loadWhichPreview(routineId, which, WHICH_TRIED); }, [key]);
  if (!answer) return null;
  const away = answer.unmatched.reduce((n, r) => n + r.signalIds.length, 0);
  const total = answer.matched.length + away + answer.undecided.length;
  if (total === 0) return <p className="eos-bp-preview">No signals yet to try it on.</p>;
  const parts = [
    `${answer.matched.length} taken`,
    ...answer.unmatched.map((r) => `${r.signalIds.length} turned away by ${ruleName(r.rule)}`),
    answer.undecided.length > 0 && `${answer.undecided.length} missing a fact`,
    answer.wouldAsk > 0 && `${answer.wouldAsk} would be asked about`,
  ].filter(Boolean);
  return <p className="eos-bp-preview">Of the last {signals(total)}: {parts.join(", ")}.</p>;
}

// Beside the Which slot: what its rules make of the routine's latest
// signals: taken, turned away by each rule, missing a fact, and how many the
// model would be asked about. A Which that takes every item tries nothing.
export function WhichPreview({ routineId, which }) {
  if (!which?.rule && !which?.ask) return null;
  return <WhichAnswer routineId={routineId} which={which} />;
}
