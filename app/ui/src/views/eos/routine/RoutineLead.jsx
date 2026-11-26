import { useEffect } from "react";
import { setRoutineState } from "../../../state/eos/routinesStore.js";
import { loadTriggerStatus, useSignals } from "../../../state/eos/signalsStore.js";
import { RUNGS } from "../blueprint/FreedomLadder.jsx";
import { buildLocation, openLocation } from "../nav/eosNav.js";
import { stateChip } from "../run/words.js";
import { kindWord } from "../routines/tableWords.js";
import { runLocation, splitItemNumber } from "./RoutineRuns.jsx";
import { HolderLine } from "./Holder.jsx";
import { UnconfirmedRecipients } from "./Unconfirmed.jsx";
import { beatRuns, nextRunAt, nowLine, timeAt } from "./words.js";

const shortDay = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

// A run's mark: the item's number, else its day; the newest also says its
// state in its tone; hovered or focused, the item's title rises over its
// mark. Item titles come from outside: React text only.
function RunMark({ run, newest, now }) {
  const chip = stateChip(run, now);
  const { number, title } = splitItemNumber(run.itemTitle);
  const at = run.startedAt ?? run.createdAt;
  const tag = number ?? (at ? shortDay.format(at) : "Run");
  const tone = chip.tone === "ok" ? "done" : (chip.tone ?? (run.state === "cancelled" || run.state === "skipped" ? "off" : "done"));
  const working = run.state === "running" || run.state === "checking";
  return (
    <li className={`eos-beat__stop eos-beat__stop--${tone}${working ? " eos-beat__stop--working" : ""}${newest ? " eos-beat__stop--newest" : ""}`}>
      <button type="button" className="eos-beat__mark" aria-label={`${run.itemTitle ? title : "A run"}, ${chip.text}`} onClick={() => openLocation(runLocation(run.id))}>
        {run.itemTitle && <span className="eos-beat__tip" aria-hidden="true">{title}</span>}
        <span className="eos-beat__dot" aria-hidden="true" />
        <span className="eos-beat__tag">{tag}</span>
        {newest && <span className={`eos-beat__word eos-beat__word--${tone}`}>{chip.text}</span>}
      </button>
    </li>
  );
}

// Where the line goes after the newest run: the next run, hollow on the
// dashed way ahead; a paused routine's halt in warn; nothing once archived.
function NextMark({ routine, nextAt }) {
  if (routine.state === "archived") return null;
  if (routine.state === "paused") {
    return (
      <li className="eos-beat__stop eos-beat__stop--ahead eos-beat__stop--paused">
        <span className="eos-beat__mark"><span className="eos-beat__dot" aria-hidden="true" /><span className="eos-beat__tag">Paused</span><span className="eos-beat__word">no runs until you resume it</span></span>
      </li>
    );
  }
  return (
    <li className="eos-beat__stop eos-beat__stop--ahead">
      <span className="eos-beat__mark">
        <span className="eos-beat__dot" aria-hidden="true" />
        <span className="eos-beat__tag">{nextAt != null ? timeAt(nextAt) : "Next"}</span>
        <span className="eos-beat__word">{nextAt != null ? "next run" : "the next run"}</span>
      </span>
    </li>
  );
}

// The routine's beat: its recent runs as marks on one line, oldest at the
// left, the way behind solid, then the way ahead dashed to the next run, as
// Home draws the day. The line runs on past both ends and fades.
export function Beat({ routine, runs, now }) {
  const status = useSignals().status[routine.id];
  useEffect(() => { void loadTriggerStatus(routine.id); }, [routine.id]);
  const shown = beatRuns(runs);
  const nextAt = nextRunAt(status, now);
  const ends = routine.state === "archived";
  return (
    <div className={ends ? "eos-beat eos-beat--ends" : "eos-beat"}>
      <ol className="eos-beat__line" aria-label="Its runs, oldest first, then the next">
        {shown.map((run, i) => <RunMark key={run.id} run={run} newest={i === shown.length - 1} now={now} />)}
        <NextMark routine={routine} nextAt={nextAt} />
      </ol>
    </div>
  );
}

// The actions a state asks for, under the words that say it: Resume and the
// last run for a paused routine (after Review the change while its Resume
// waits for recipients), the run that failed, Resume for an archived
// one. Each is here only, never also in the header.
function StateActions({ routine, refusal, failed }) {
  const last = routine.lastRun;
  if (routine.state === "paused") {
    return (
      <div className="eos-rlead__acts">
        {refusal && <button type="button" className="eos-btn eos-btn--primary" onClick={() => openLocation(buildLocation({ screen: "routine", routineId: routine.id, tab: "blueprint" }))}>Review the change</button>}
        <button type="button" className={refusal ? "eos-btn" : "eos-btn eos-btn--primary"} onClick={() => void setRoutineState(routine.id, "active")}>Resume</button>
        {last && <button type="button" className="eos-btn eos-btn--quiet" onClick={() => openLocation(runLocation(last.id))}>Open the last run</button>}
      </div>
    );
  }
  if (routine.state === "archived") {
    return (
      <div className="eos-rlead__acts">
        <button type="button" className="eos-btn" onClick={() => void setRoutineState(routine.id, "active")}>Bring it back</button>
      </div>
    );
  }
  if (failed) {
    return (
      <div className="eos-rlead__acts">
        <button type="button" className="eos-btn" onClick={() => openLocation(runLocation(last.id))}>Open the run</button>
      </div>
    );
  }
  return null;
}

// The top of a routine's page, as Home greets: what kind of routine and how
// free it is, what it does in one large line, and where it stands now in a
// dimmer one; then what that state asks for, and the beat of its runs.
export function RoutineLead({ routine, runs, waiting, refusal, now }) {
  const rung = RUNGS.find((r) => r.value === routine.rung)?.label;
  // Once Resume was refused until recipients are confirmed, that is where it
  // stands: the core's words and the recipients follow under the line.
  const standing = refusal ? { text: "Paused until you confirm who it sends to.", tone: "warn" } : nowLine({ routine, runs, waiting });
  const tone = standing.tone;
  return (
    <header className="eos-rlead">
      <p className="eos-label">{[`${kindWord(routine.kind)} routine`, rung].filter(Boolean).join(" · ")}</p>
      <div>
        <p className="eos-routine__summary">{routine.summary}</p>
        <p className={tone ? `eos-rlead__now eos-rlead__now--${tone}` : "eos-rlead__now"} role={tone ? "status" : undefined}>
          {standing.text}
        </p>
        {routine.triggerLine && <p className="eos-routine__line">{routine.triggerLine}</p>}
        <HolderLine routine={routine} />
      </div>
      {refusal && <UnconfirmedRecipients refusal={refusal} />}
      <StateActions routine={routine} refusal={refusal} failed={tone === "err"} />
      <Beat routine={routine} runs={runs} now={now} />
    </header>
  );
}

// The lead's ghost while the routine is read: its label and two lines as
// bars, and the beat as a dashed line of hollow marks; after 300 ms.
export function RoutineLeadGhost() {
  return (
    <div className="eos-skeleton eos-rlead eos-rlead--ghost" aria-busy="true" aria-label="Loading">
      <span className="eos-skeleton__label" />
      <span className="eos-rlead__bar" />
      <span className="eos-rlead__bar eos-rlead__bar--dim" />
      <div className="eos-beat eos-beat--ghost" aria-hidden="true">
        <ol className="eos-beat__line">
          {Array.from({ length: 6 }, (_, i) => (
            <li key={i} className="eos-beat__stop eos-beat__stop--ahead"><span className="eos-beat__mark"><span className="eos-beat__dot" /></span></li>
          ))}
        </ol>
      </div>
    </div>
  );
}
