// A small menu of one choice among a few (the input's pills, the verb, an
// option's values): each item its name and, when it has one, a line of what
// it means; the chosen one carries a check. `label` names the menu for a
// screen reader; `end` opens it from the trigger's right edge.
export function ChoiceMenu({ label, items, value, onPick, end }) {
  return (
    <span className={end ? "eos-intent__menu eos-intent__menu--end" : "eos-intent__menu"} role="menu" aria-label={label}>
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitemradio"
          aria-checked={item.value === value}
          className={item.line ? "eos-intent__menuitem eos-intent__menuitem--two" : "eos-intent__menuitem"}
          onClick={() => onPick(item.value)}
        >
          <span className="eos-intent__menuname">{item.label}</span>
          {item.line && <span className="eos-intent__menuline">{item.line}</span>}
          <svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" className="eos-intent__menucheck"><path d="M3.5 8.5l3 3 6-7" /></svg>
        </button>
      ))}
    </span>
  );
}
