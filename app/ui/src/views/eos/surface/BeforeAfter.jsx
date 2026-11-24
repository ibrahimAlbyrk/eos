// Before and After of a new version, drawn with the same issue.
export function BeforeAfter({ showing, onShow }) {
  return (
    <div className="eos-seg" role="radiogroup" aria-label="Compare versions">
      {[["before", "Before"], ["after", "After"]].map(([value, label]) => (
        <button key={value} type="button" role="radio" aria-checked={showing === value} className="eos-seg__opt" onClick={() => onShow(value)}>
          {label}
        </button>
      ))}
    </div>
  );
}
