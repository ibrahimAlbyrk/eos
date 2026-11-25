import { useEffect, useRef, useState } from "react";
import { ChoiceRow } from "./ChoiceRow.jsx";
import { TAB_CYCLES_CHOICES } from "./intent/inputReducer.js";
import {
  choiceLine, DECIDING_LINE, FAILED_LINE, FIRST_HINT, IDLE_HINT, MENU_LINE, READING_LINE, TAB_HINT, UNSURE_LINE, VERBS,
} from "./intent/intentWords.js";

const ANNOUNCE_AFTER_MS = 500;

// What the line says now: { text, enter (↵ shown), dim, hint }.
export function lineOf({ verdict, options, input, byId, previous }) {
  if (input.pendingEnter) return { text: DECIDING_LINE, enter: false, dim: true };
  switch (verdict.kind) {
    case "idle": return { text: byId?.size === 0 ? FIRST_HINT : IDLE_HINT, enter: false, hint: true };
    case "menu": return { text: MENU_LINE, enter: false };
    case "sure": return { text: choiceLine(options[input.tab % options.length], byId), enter: true };
    case "choices": return { text: UNSURE_LINE, enter: false, unsure: true };
    case "failed": return { text: FAILED_LINE, enter: false, unsure: true };
    default: return verdict.slow || !previous ? { text: READING_LINE, enter: false, dim: true } : { ...previous, dim: true };
  }
}

// Speaks a line only once it has held for half a second, so typing is not
// read out letter by letter.
function useHeld(text) {
  const [held, setHeld] = useState(text);
  useEffect(() => {
    const timer = setTimeout(() => setHeld(text), ANNOUNCE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [text]);
  return held;
}

// The verb at the start of the line (08 G11): a menu of Auto, Run, Make,
// Once and Change. Forced, it reads "Run ▾".
function VerbMenu({ forced, onForce }) {
  const [open, setOpen] = useState(false);
  const label = VERBS.find((v) => v.intent === forced)?.label;
  return (
    <span className="eos-intent__verb">
      <button
        type="button"
        className={forced ? "eos-intent__verbbtn eos-intent__verbbtn--forced" : "eos-intent__verbbtn"}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={forced ? `Enter will ${label.toLowerCase()}. Change` : "Choose what Enter does"}
        onClick={() => setOpen(!open)}
      >
        {forced ? `${label} ▾` : "▾"}
      </button>
      {open && (
        <span className="eos-intent__menu" role="menu">
          {VERBS.map((v) => (
            <button
              key={v.label}
              type="button"
              role="menuitemradio"
              aria-checked={v.intent === forced}
              className="eos-intent__menuitem"
              onClick={() => { setOpen(false); onForce(v.intent); }}
            >
              {v.label}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

// The line under the input (RunIntent.dc.html): ↵ and what Enter will do,
// "Tab for other choices" while there are two or more; when unsure, the
// choices. While the core decides, the last line stays dimmed.
export function IntentLine({ intent, byId, onMenu }) {
  const { verdict, options, input, dispatch, choose } = intent;
  const previous = useRef(null);
  const line = lineOf({ verdict, options, input, byId, previous: previous.current });
  useEffect(() => {
    if (!line.dim && line.enter) previous.current = line;
  });
  const announced = useHeld(line.text);
  const tabHint = TAB_CYCLES_CHOICES && verdict.kind === "sure" && options.length >= 2;
  return (
    <div className="eos-intent">
      <div className={`eos-intent__line${line.dim ? " eos-intent__line--dim" : ""}${line.hint ? " eos-intent__line--hint" : ""}`}>
        {line.enter && <span className="eos-intent__key" aria-hidden="true">↵</span>}
        {(line.enter || input.forced) && <VerbMenu forced={input.forced} onForce={(intentKind) => dispatch({ type: "force", intent: intentKind })} />}
        <span className={line.unsure ? "eos-intent__text eos-intent__text--unsure" : "eos-intent__text"}>{line.text}</span>
        {tabHint && <span className="eos-intent__tab">{TAB_HINT}</span>}
      </div>
      {line.unsure && (
        <ChoiceRow choices={options} byId={byId} current={input.tabbed ? input.tab % options.length : -1} onChoose={choose} onMenu={onMenu} />
      )}
      <span className="eos-sr" aria-live="polite">{announced}</span>
    </div>
  );
}
