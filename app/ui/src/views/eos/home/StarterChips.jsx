import { STARTER_CHIPS } from "./homeWords.js";

// Sentences to start from: a chip fills the input and never sends.
export function StarterChips({ onPick }) {
  return (
    <div className="eos-starters">
      {STARTER_CHIPS.map((text) => (
        <button key={text} type="button" className="eos-starter" onClick={() => onPick?.(text)}>{text}</button>
      ))}
    </div>
  );
}
