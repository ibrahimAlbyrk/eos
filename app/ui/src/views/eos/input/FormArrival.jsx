import { useEffect, useRef, useState } from "react";
import { offeredRoutines, useRoutines } from "../../../state/eos/routinesStore.js";
import { startRun } from "../../../state/eos/runsStore.js";
import { open as openRunSheet } from "../../../state/eos/runSheetStore.js";
import { routineNamed } from "../../../lib/runCommand.js";
import { buildLocation, openLocation } from "../nav/eosNav.js";
import { resultWord } from "../run/words.js";
import { refusalText } from "../runform/RunForm.jsx";

// What an `eos:/form` location fills the form with. It came from outside Eos
// (a link, another app), so its item is never taken for the user's words.
export function formInput(location, routine) {
  const takes = routine.takes ?? { kind: "text" };
  const text = location.item?.trim();
  const item = text
    ? { ...(/^https?:\/\//i.test(text) ? { kind: takes.kind, url: text } : { kind: takes.kind, text }), title: text, untrusted: true }
    : undefined;
  const types = Object.fromEntries((routine.options ?? []).map((o) => [o.key, o.type]));
  const options = {};
  for (const [key, value] of Object.entries(location.options ?? {})) {
    if (!(key in types)) continue;
    options[key] = types[key] === "bool" ? value === "1" || value === "true" : value;
  }
  const at = location.at ? Date.parse(location.at) : NaN;
  return {
    ...(item ? { item } : {}),
    options,
    ...(location.note ? { note: location.note } : {}),
    result: location.showOnly ? "showOnly" : "usual",
    ...(Number.isFinite(at) ? { at } : {}),
  };
}

// The link as the user would have clicked it, shown so they see what asks.
export function linkText(location) {
  const query = new URLSearchParams();
  if (location.item) query.set("item", location.item);
  if (location.note) query.set("note", location.note);
  for (const [k, v] of Object.entries(location.options ?? {})) query.set(`opt.${k}`, v);
  if (location.showOnly) query.set("show-only", "1");
  if (location.at) query.set("at", location.at);
  const q = query.toString();
  return `eos://run/${location.routine}${q ? `?${q}` : ""}`;
}

const optionLabel = (routine, key) => routine.options?.find((o) => o.key === key)?.label ?? key;

const home = () => openLocation(buildLocation({ screen: "home" }));

// "A link wants to start a run" (RunOutside): everything the link sets, one
// row each, Run to start it, Cancel to drop it. A link never starts anything
// by itself.
export function LinkDialog({ location, routine }) {
  const [refused, setRefused] = useState(null);
  const [starting, setStarting] = useState(false);
  const requestId = useRef(crypto.randomUUID());
  const input = routine ? formInput(location, routine) : null;
  const run = async () => {
    if (starting || !routine) return;
    setStarting(true);
    const answer = await startRun({ routineId: routine.id, input, door: "link", clientRequestId: requestId.current });
    setStarting(false);
    if (answer.runs) return openLocation(buildLocation({ screen: "run", runId: answer.runs[0].id }));
    setRefused(answer.repeat ? `${routine.name} handled this item lately. Open it from the routine's runs.` : refusalText(answer));
  };
  return (
    <div className="eos-runsheet eos-runsheet--centre" onMouseDown={(e) => { if (e.target === e.currentTarget) home(); }}>
      <div className="eos-runsheet__panel eos-linkdialog" role="dialog" aria-label="A link wants to start a run">
        <div className="eos-linkdialog__title">A link wants to start a run</div>
        <div className="eos-linkdialog__link">{linkText(location)}</div>
        {routine ? (
          <dl className="eos-linkdialog__rows">
            <div><dt>Routine</dt><dd>{routine.name}</dd></div>
            {input.item && <div><dt>Item</dt><dd>{input.item.title}</dd></div>}
            {input.note && <div><dt>Note</dt><dd>{input.note}</dd></div>}
            {Object.entries(input.options).map(([key, value]) => (
              <div key={key}><dt>{optionLabel(routine, key)}</dt><dd>{String(value)}</dd></div>
            ))}
            {input.at !== undefined && <div><dt>When</dt><dd>{new Date(input.at).toLocaleString()}</dd></div>}
            <div><dt>Result</dt><dd>{resultWord(input.result)}</dd></div>
          </dl>
        ) : (
          <p className="eos-note">There is no routine named {location.routine}.</p>
        )}
        {refused && <p className="eos-note eos-runform__problem" role="alert">{refused}</p>}
        <div className="eos-linkdialog__acts">
          {routine && <button type="button" className="eos-btn eos-btn--primary" disabled={starting} onClick={() => void run()}>Run</button>}
          <button type="button" className="eos-btn" onClick={home}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// An `eos:/form` location over Home: a link asks first in its dialog; any
// other opens the run sheet filled, centred, as Home's own door: "form" is
// no door the core knows.
export function FormArrival({ location }) {
  const { list } = useRoutines();
  const routine = routineNamed(offeredRoutines(list), location.routine);
  const fromLink = location.from === "link";
  const routineId = routine?.id;
  useEffect(() => {
    if (fromLink || !routineId) return;
    openRunSheet({ routineId, input: formInput(location, routine), door: "home" });
    home();
    // Once per arrival: the location names it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromLink, routineId]);
  if (list === null || (!fromLink && routine)) return null;
  return <LinkDialog location={location} routine={routine} />;
}
