import { useEffect, useRef, useState } from "react";
import { useKeybinding } from "../../../keymap/useKeymap.js";
import { shortcutLabel } from "../../../lib/platform.js";
import { ensureAccountsLoaded, useAccounts } from "../../../state/accountsStore.js";
import { estimateRun, loadRun, startRun, useRuns } from "../../../state/eos/runsStore.js";
import { DEV_RUN_TEXT } from "../capabilities/parts.jsx";
import { primaryKey } from "../needs/keys.js";
import { buildLocation, openLocation } from "../nav/eosNav.js";
import { runLocation } from "../routine/RoutineRuns.jsx";
import { CandidateCombobox } from "./CandidateCombobox.jsx";
import { LaterPicker } from "./LaterPicker.jsx";
import { OptionControl } from "./OptionControl.jsx";
import {
  billsByRun, chosenItems, estimateBody, estimateLine, formProblem, isLive, optionsOf, repeatLine, RESULTS, splitOptions,
  startBody, takesItems, usualEstimate,
} from "./runFormModel.js";

const DAY_CAP_TEXT = "Routines have spent today's budget. Raise it for today to start this run.";
const OFFLINE_TEXT = "Eos isn't reachable. Try again in a moment.";

const newRequestId = () => crypto.randomUUID();

// What came back from the last Run: a refusal in words, or the earlier run
// of the same item with the choice to run again.
function Outcome({ outcome, routine, details, now, runAgain }) {
  if (!outcome) return null;
  if (outcome.repeat) {
    const earlier = details[outcome.repeat];
    if (!earlier) return <p className="eos-note" role="status">{routine.name} handled this item lately.</p>;
    const live = isLive(earlier);
    return (
      <div className="eos-runform__repeat" role="status">
        <span>{repeatLine(routine, earlier, now)}</span>
        {live && <button type="button" className="eos-btn eos-btn--primary" onClick={() => openLocation(runLocation(outcome.repeat))}>Open the run</button>}
        <button type="button" className="eos-btn" onClick={runAgain}>{live ? "Run again anyway" : "Run again"}</button>
      </div>
    );
  }
  const text = outcome.devRun ? DEV_RUN_TEXT : outcome.dayCap ? DAY_CAP_TEXT : outcome.offline ? OFFLINE_TEXT : outcome.error;
  return <p className="eos-note eos-runform__problem" role="alert">{text}</p>;
}

// The run form (08 §4.7) over runFormModel: the item, the options, a note,
// where the result goes, when, the estimate and Run ⌘↵. `layout` is "sheet"
// (with its title) or "inline" (inside another screen). Starting waits for
// the core; a started run opens its run view.
export function RunForm({ routine, blueprint, form, setForm, layout, door, againOf, autoFocus, onStarted }) {
  const { accounts } = useAccounts();
  const { details } = useRuns();
  const [estimate, setEstimate] = useState(null);
  const [outcome, setOutcome] = useState(null);
  const [problem, setProblem] = useState(null);
  const [starting, setStarting] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const requestId = useRef(null);
  const now = Date.now();

  const options = optionsOf(routine, blueprint);
  const { inline, more } = splitOptions(options);
  const count = Math.max(1, chosenItems(form, routine.takes).length);
  const estimateKey = JSON.stringify(estimateBody(routine, options, { ...form, note: "" }));

  useEffect(() => { void ensureAccountsLoaded(); }, []);
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      void estimateRun(JSON.parse(estimateKey)).then((answer) => { if (live) setEstimate(answer); });
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [estimateKey]);
  // A changed form is a new submit; a retry of the same one keeps its id.
  useEffect(() => { requestId.current = null; }, [form]);

  const change = (patch) => {
    setOutcome(null);
    setProblem(null);
    setForm({ ...form, ...patch });
  };
  const setOption = (key, value) => change({ options: { ...form.options, [key]: value } });

  const run = async (confirmRepeat = false) => {
    if (starting) return;
    const why = formProblem(form, routine, Date.now());
    setProblem(why);
    if (why) return;
    if (confirmRepeat || !requestId.current) requestId.current = newRequestId();
    setStarting(true);
    const answer = await startRun(startBody(routine, options, form, { door, clientRequestId: requestId.current, confirmRepeat, againOf }));
    setStarting(false);
    if (answer.repeat) await loadRun(answer.repeat);
    if (!answer.runs) return setOutcome(answer);
    onStarted?.(answer.runs);
    openLocation(answer.runs.length === 1 ? runLocation(answer.runs[0].id) : buildLocation({ screen: "routine", routineId: routine.id, tab: "runs" }));
  };

  useKeybinding({
    match: primaryKey,
    priority: 1,
    run: (ctx, e) => {
      e.preventDefault();
      void run();
    },
  }, [form, starting, door, againOf]);

  const line = estimateLine(estimate ?? usualEstimate(routine, options, form, count), { form, inline, plan: !billsByRun(accounts) });
  const option = (o) => <OptionControl key={o.key} option={o} value={form.options[o.key] ?? o.default} onChange={(v) => setOption(o.key, v)} />;
  return (
    <form
      className={`eos-runform eos-runform--${layout}`}
      aria-label={`Run ${routine.name}`}
      onSubmit={(e) => { e.preventDefault(); void run(); }}
    >
      {layout === "sheet" && (
        <div>
          <h1 className="eos-runform__title">Run {routine.name}</h1>
          {routine.summary && <p className="eos-runform__summary">{routine.summary}</p>}
        </div>
      )}
      {takesItems(routine.takes) && (
        <CandidateCombobox routineId={routine.id} takes={routine.takes} form={form} setForm={(next) => change(next)} autoFocus={autoFocus} />
      )}
      {inline.map(option)}
      {more.length > 0 && (
        <button type="button" className="eos-link eos-runform__more" aria-expanded={showMore} onClick={() => setShowMore(!showMore)}>
          {showMore ? "Fewer options" : "More options"}
        </button>
      )}
      {showMore && more.map(option)}
      <div className="eos-runform__field">
        <label className="eos-runform__label" htmlFor="runform-note">Note for this run</label>
        <input id="runform-note" type="text" className="eos-runform__input" value={form.note} onChange={(e) => change({ note: e.target.value })} />
      </div>
      <div className="eos-runform__row">
        <span className="eos-runform__label" id="runform-result">Result</span>
        <div className="eos-seg" role="radiogroup" aria-labelledby="runform-result">
          {RESULTS.map((r) => (
            <button key={r.value} type="button" role="radio" aria-checked={form.result === r.value} className="eos-seg__opt" onClick={() => change({ result: r.value })}>
              {r.label}
            </button>
          ))}
        </div>
      </div>
      <LaterPicker at={form.at} now={now} onChange={(at) => change({ at })} />
      {problem && <p className="eos-note eos-runform__problem" role="alert">{problem}</p>}
      <Outcome outcome={outcome} routine={routine} details={details} now={now} runAgain={() => void run(true)} />
      <div className="eos-runform__foot">
        <span className="eos-runform__estimate">{line}</span>
        <button type="submit" className="eos-btn eos-btn--primary" disabled={starting}>
          {starting ? "Starting…" : "Run"} <span className="eos-needs-key">{shortcutLabel("mod+return")}</span>
        </button>
      </div>
    </form>
  );
}
