// One of the routine's options in the run form, by its type: a choice as a
// radiogroup, a switch as a checkbox, text and numbers as fields.

const valueWord = (value) => String(value).charAt(0).toUpperCase() + String(value).slice(1);

export function OptionControl({ option, value, onChange }) {
  const id = `runform-opt-${option.key}`;
  let control;
  if (option.type === "choice") {
    control = (
      <div className="eos-seg" role="radiogroup" aria-labelledby={id}>
        {(option.values ?? []).map((v) => (
          <button key={v} type="button" role="radio" aria-checked={value === v} className="eos-seg__opt" onClick={() => onChange(v)}>
            {valueWord(v)}
          </button>
        ))}
      </div>
    );
  } else if (option.type === "bool") {
    control = <input type="checkbox" aria-labelledby={id} checked={value === true} onChange={(e) => onChange(e.target.checked)} />;
  } else if (option.type === "number") {
    control = (
      <input
        type="number"
        className="eos-runform__input eos-runform__input--short"
        aria-labelledby={id}
        value={value ?? ""}
        onChange={(e) => e.target.value !== "" && onChange(Number(e.target.value))}
      />
    );
  } else {
    control = <input type="text" className="eos-runform__input" aria-labelledby={id} value={value ?? ""} onChange={(e) => onChange(e.target.value)} />;
  }
  return (
    <div className="eos-runform__row">
      <span className="eos-runform__label" id={id} title={option.help}>{option.label}</span>
      {control}
    </div>
  );
}
