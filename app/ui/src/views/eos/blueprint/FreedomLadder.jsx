import { useId, useState } from "react";

// The Freedom row: how far a result goes without the user, as a radiogroup
// of 03's rungs. The user may pick any rung (G30); raising a routine that
// speaks for the user to "Send, then tell me" or "On its own" asks first in
// Eos's own dialog, outside anything an agent wrote. The two unattended
// rungs stay locked until the safety suite passes: the core holds every
// result as a draft at most, so the ladder shows "Draft, I send" as what
// applies and offers neither.

export const RUNGS = [
  { value: "ask", label: "Ask each time" },
  { value: "draft", label: "Draft, I send" },
  { value: "send_then_tell", label: "Send, then tell me" },
  { value: "on_its_own", label: "On its own" },
];

const UNATTENDED = new Set(["send_then_tell", "on_its_own"]);

export const LOCKED_LINE = "After the safety suite passes";

// The rung that applies: an unattended one is held as a draft.
const applying = (rung) => (UNATTENDED.has(rung) ? "draft" : rung);

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

// `onApply` takes the new Freedom slot; without it the ladder is read-only.
export function FreedomLadder({ blueprint, onApply, changed = false }) {
  const [asking, setAsking] = useState(null);
  const rung = blueprint.freedom?.rung ?? "draft";
  const applies = applying(rung);
  const lockedId = useId();
  const pick = (value) => {
    if (value === rung) return;
    const question = freedomQuestion(blueprint, value);
    if (question) setAsking({ value, question });
    else onApply(withRung(blueprint.freedom, value));
  };
  return (
    <div className={changed ? "eos-bp-row eos-bp-row--changed" : "eos-bp-row"}>
      <dt className="eos-bp-row__label">Freedom{changed && <span className="eos-bp-row__mark">Changed</span>}</dt>
      <dd className="eos-bp-row__value">
        <div className="eos-seg" role="radiogroup" aria-label="How much Eos may do on its own">
          {RUNGS.map((r) => {
            const locked = UNATTENDED.has(r.value);
            const open = onApply && !locked;
            return (
              <button
                key={r.value}
                type="button"
                role="radio"
                aria-checked={r.value === applies}
                aria-disabled={open ? undefined : true}
                tabIndex={locked ? -1 : undefined}
                aria-describedby={locked ? lockedId : undefined}
                className="eos-seg__opt"
                onClick={open ? () => pick(r.value) : undefined}
              >
                {r.label}
              </button>
            );
          })}
        </div>
        <p id={lockedId} className="eos-note">{LOCKED_LINE}</p>
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
