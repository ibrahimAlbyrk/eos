import { choiceLabel } from "./intent/intentWords.js";

// The choices of an unsure reading (RunIntent.dc.html, "When Eos is not
// sure, it asks"): one button each; the one Tab moved to is marked. The
// routine menu choice opens the menu instead of acting.
export function ChoiceRow({ choices, byId, current, onChoose, onMenu }) {
  return (
    <div className="eos-choices" role="group" aria-label="Choices">
      {choices.map((c, i) => (
        <button
          key={`${c.intent}-${c.routineId ?? i}`}
          type="button"
          className={i === current ? "eos-choice eos-choice--on" : "eos-choice"}
          onClick={() => (c.intent === "menu" ? onMenu?.() : onChoose(c))}
        >
          {c.intent === "menu" ? "Your routines" : choiceLabel(c, byId)}
        </button>
      ))}
    </div>
  );
}
