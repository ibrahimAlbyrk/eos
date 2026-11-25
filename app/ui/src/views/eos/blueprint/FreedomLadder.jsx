import { useEffect, useState } from "react";
import { loadFreedom, useFreedom } from "../../../state/eos/freedomStore.js";
import { RowLabel, rowClass } from "./SlotRow.jsx";

// The Freedom row: how far a result goes without the user, as a radiogroup
// of 03's rungs. The user may pick any rung (G30); raising a routine that
// speaks for the user to "Send, then tell me" or "On its own" asks first in
// Eos's own dialog, outside anything an agent wrote.

export const RUNGS = [
  { value: "ask", label: "Ask each time" },
  { value: "draft", label: "Draft, I send" },
  { value: "send_then_tell", label: "Send, then tell me" },
  { value: "on_its_own", label: "On its own" },
];

const UNATTENDED = new Set(["send_then_tell", "on_its_own"]);

const ACTS = { "github.review": "post reviews", mail: "send mail", "mail.reply": "send mail" };

// A routine speaks for the user when a result goes anywhere but to the user.
const speaksForUser = (bp) => (bp.goesTo ?? []).some((r) => r.kind !== "me");

// The dialog's question when picking `rung` asks first, else null.
export function freedomQuestion(bp, rung) {
  const current = RUNGS.findIndex((r) => r.value === bp.freedom?.rung);
  const next = RUNGS.findIndex((r) => r.value === rung);
  if (!UNATTENDED.has(rung) || next <= current || !speaksForUser(bp)) return null;
  return `${bp.name} will ${ACTS[bp.makes?.kind] ?? "send its results"} as you without asking. Allow?`;
}

// Freedom at `rung`, its grants and unknown keys kept.
export const withRung = (freedom, rung) => ({ ...freedom, rung });

function Ask({ question, allow, cancel }) {
  return (
    <div className="eos-sheet-overlay" onMouseDown={cancel}>
      <div className="eos-sheet" role="alertdialog" aria-modal="true" aria-labelledby="eos-bp-freedom-ask" onMouseDown={(e) => e.stopPropagation()}>
        <p id="eos-bp-freedom-ask" className="eos-sheet__title">{question}</p>
        <div className="eos-actions">
          <button type="button" className="eos-btn eos-btn--primary" onClick={allow}>Allow</button>
          <button type="button" className="eos-btn" onClick={cancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// Ten results in a row sent as they were earn an offer of the next rung (03 §4.6).
const OFFER_AFTER = 10;

// Where the routine stands toward its next offer, from its confirmed Freedom.
export function streakLine(view) {
  if (!view || view.rung === "on_its_own") return null;
  if (view.offer === "never") return "Eos will not offer this routine more freedom.";
  if (view.offer === "offered") return "Eos offers the next step in Needs you.";
  if (view.streak > 0) {
    return `${view.streak} of ${OFFER_AFTER} in a row went out unedited. Eos will offer the next step at ${OFFER_AFTER}.`;
  }
  return "Eos will offer the next step once ten in a row go out unedited.";
}

function StreakLine({ routineId }) {
  const view = useFreedom().byRoutine[routineId];
  useEffect(() => {
    void loadFreedom(routineId);
  }, [routineId]);
  const line = streakLine(view);
  return line && <p className="eos-bp-row__note">{line}</p>;
}

// `onApply` takes the new Freedom slot; without it the ladder is read-only.
// With `routineId`, the line under it says how near the next offer is.
// `state` is the row's mark (SlotRow); a blueprint with no Freedom yet says
// what it is for (`hint`) instead of a ladder.
export function FreedomLadder({ blueprint, onApply, state = "filled", hint, routineId }) {
  const [asking, setAsking] = useState(null);
  const rung = blueprint.freedom?.rung ?? "draft";
  const pick = (value) => {
    if (value === rung) return;
    const question = freedomQuestion(blueprint, value);
    if (question) setAsking({ value, question });
    else onApply(withRung(blueprint.freedom, value));
  };
  if (blueprint.freedom === undefined && (state === "writing" || state === "empty")) {
    return (
      <div className={rowClass(state)}>
        <RowLabel label="Freedom" state={state} />
        <dd className="eos-bp-row__value">
          <span className="eos-bp-row__hint">{state === "writing" && <span className="eos-bp-row__bar" aria-hidden="true" />}{hint}</span>
        </dd>
      </div>
    );
  }
  return (
    <div className={rowClass(state === "empty" ? "filled" : state)}>
      <RowLabel label="Freedom" state={state} />
      <dd className="eos-bp-row__value">
        <div className="eos-seg eos-bp-ladder" role="radiogroup" aria-label="How much Eos may do on its own">
          {RUNGS.map((r) => (
            <button
              key={r.value}
              type="button"
              role="radio"
              aria-checked={r.value === rung}
              aria-disabled={onApply ? undefined : true}
              className="eos-seg__opt"
              onClick={onApply ? () => pick(r.value) : undefined}
            >
              {r.label}
            </button>
          ))}
        </div>
        {routineId && <StreakLine routineId={routineId} />}
        {asking && (
          <Ask
            question={asking.question}
            allow={() => {
              onApply(withRung(blueprint.freedom, asking.value));
              setAsking(null);
            }}
            cancel={() => setAsking(null)}
          />
        )}
      </dd>
    </div>
  );
}
