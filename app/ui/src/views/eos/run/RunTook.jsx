import { valueWord } from "../runform/OptionControl.jsx";
import { itemLine, resultWord } from "./words.js";

// What this run took: its item, the options it ran with, the user's note and
// what happens to its result. Item titles come from outside: React text only.
export function RunTook({ input, options }) {
  const item = itemLine(input);
  const labelOf = (key) => options?.find((o) => o.key === key)?.label ?? key;
  return (
    <section className="eos-run-aside__part">
      <h2 className="eos-label">What this run took</h2>
      <dl className="eos-facts">
        {item && <div className="eos-facts__row"><dt>Item</dt><dd>{item}</dd></div>}
        {Object.entries(input.options ?? {}).map(([key, value]) => (
          <div key={key} className="eos-facts__row"><dt>{labelOf(key)}</dt><dd>{valueWord(value)}</dd></div>
        ))}
        {input.note && <div className="eos-facts__row"><dt>Note</dt><dd>{input.note}</dd></div>}
        <div className="eos-facts__row"><dt>Result</dt><dd>{resultWord(input.result)}</dd></div>
      </dl>
    </section>
  );
}
