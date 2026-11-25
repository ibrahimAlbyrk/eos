import { useEffect, useState } from "react";
import { loadCandidates } from "../../../state/eos/routinesStore.js";
import { chipLabel } from "./runFormModel.js";

// The item field: an APG combobox (https://www.w3.org/WAI/ARIA/apg/patterns/combobox/)
// over the routine's candidates, the recent ones as chips under it, and what
// an empty field does. Typed text stays as it is and is checked as an item.

const LIST_ID = "runform-candidates";
const RECENT = 3;

// A key in the field → the next { open, active } and, on Enter, the index
// chosen. Down opens the list or moves on, Up moves back, Enter takes the
// active one, Escape closes an open list.
export function comboKey({ open, active }, key, count) {
  if (key === "ArrowDown") {
    if (!open) return { open: count > 0, active: count > 0 ? 0 : -1 };
    return { open, active: count ? (active + 1) % count : -1 };
  }
  if (key === "ArrowUp") {
    if (!open) return { open: count > 0, active: count - 1 };
    return { open, active: count ? (active - 1 + count) % count : -1 };
  }
  if (key === "Enter" && open && active >= 0 && active < count) return { open: false, active: -1, chosen: active };
  if (key === "Escape" && open) return { open: false, active: -1 };
  return null;
}

// The form with `item` chosen: added to the items when the routine takes
// several, else in place of the one before.
export function withChosen(form, item, many) {
  if (!many) return { ...form, item, text: "" };
  const same = (a) => (item.key ? a.key === item.key : a === item);
  return form.items.some(same) ? { ...form, text: "" } : { ...form, items: [...form.items, item], text: "" };
}

const itemName = (item) => item.title ?? item.text ?? item.url ?? item.path ?? chipLabel(item);

function Chosen({ form, setForm, many }) {
  const chosen = many ? form.items : form.item ? [form.item] : [];
  if (!chosen.length) return null;
  const remove = (item) => setForm(many ? { ...form, items: form.items.filter((i) => i !== item) } : { ...form, item: null });
  return (
    <div className="eos-runform__chosen">
      {chosen.map((item, i) => (
        <span key={item.key ?? i} className="eos-chip">
          <span className="eos-runform__mono">{chipLabel(item)}</span> {itemName(item)}
          <button type="button" className="eos-runform__remove" aria-label={`Remove ${chipLabel(item)}`} onClick={() => remove(item)}>×</button>
        </span>
      ))}
    </div>
  );
}

export function CandidateCombobox({ routineId, takes, form, setForm, autoFocus }) {
  const [list, setList] = useState({ open: false, active: -1 });
  const [items, setItems] = useState([]);
  const [recent, setRecent] = useState([]);
  const many = Boolean(takes.many);

  useEffect(() => {
    let live = true;
    void loadCandidates(routineId).then((found) => { if (live) setRecent(found.slice(0, RECENT)); });
    return () => { live = false; };
  }, [routineId]);
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      void loadCandidates(routineId, form.text).then((found) => { if (live) setItems(found); });
    }, 150);
    return () => { live = false; clearTimeout(timer); };
  }, [routineId, form.text]);

  const choose = (item) => {
    setForm(withChosen(form, item, many));
    setList({ open: false, active: -1 });
  };
  const onKeyDown = (e) => {
    const next = comboKey(list, e.key, items.length);
    if (!next) return;
    e.preventDefault();
    if (next.chosen !== undefined) choose(items[next.chosen]);
    else setList(next);
  };
  const open = list.open && items.length > 0;
  const label = takes.label.charAt(0).toUpperCase() + takes.label.slice(1);
  return (
    <div className="eos-runform__field">
      <label className="eos-runform__label" htmlFor="runform-item">{label}</label>
      <Chosen form={form} setForm={setForm} many={many} />
      <input
        id="runform-item"
        type="text"
        role="combobox"
        className="eos-runform__input"
        autoComplete="off"
        autoFocus={autoFocus}
        aria-expanded={open}
        aria-controls={LIST_ID}
        aria-autocomplete="list"
        aria-activedescendant={open && list.active >= 0 ? `${LIST_ID}-${list.active}` : undefined}
        placeholder={takes.placeholder}
        value={form.text}
        onChange={(e) => {
          setForm(many ? { ...form, text: e.target.value } : { ...form, item: null, text: e.target.value });
          setList({ open: true, active: -1 });
        }}
        onKeyDown={onKeyDown}
        onBlur={() => setList({ open: false, active: -1 })}
      />
      {open && (
        <ul id={LIST_ID} role="listbox" className="eos-runform__list" aria-label={`${label}s`}>
          {items.map((item, i) => (
            <li
              key={item.key ?? i}
              id={`${LIST_ID}-${i}`}
              role="option"
              aria-selected={i === list.active}
              className="eos-runform__option"
              onMouseDown={(e) => { e.preventDefault(); choose(item); }}
            >
              <span className="eos-runform__mono">{chipLabel(item)}</span>
              <span className="eos-runform__optname">{itemName(item)}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="eos-runform__recent">
        {recent.length > 0 && <span>Recent</span>}
        {recent.map((item, i) => (
          <button key={item.key ?? i} type="button" className="eos-chip eos-runform__mono" title={itemName(item)} onClick={() => choose(item)}>
            {chipLabel(item)}
          </button>
        ))}
        {takes.empty === "latest" && <span className="eos-runform__hint">Empty takes the latest</span>}
      </div>
    </div>
  );
}
