import { useState } from "react";
import { open as openRunSheet } from "../../../state/eos/runSheetStore.js";
import { LaterPicker, whenWords } from "../runform/LaterPicker.jsx";
import { ChoiceMenu } from "./ChoiceMenu.jsx";
import { optionsOf, splitOptions, startBody } from "../runform/runFormModel.js";

const word = (v) => String(v).charAt(0).toUpperCase() + String(v).slice(1);

const Chevron = () => (
  <svg aria-hidden="true" width="9" height="9" viewBox="0 0 16 16" className="eos-pill__chev"><path d="M4 6l4 4 4-4" /></svg>
);

// The run form's input as the sheet reads it, so More opens it filled.
export function sheetInput(routine, form) {
  const body = startBody(routine, optionsOf(routine), form, { door: "home", clientRequestId: "" });
  return { ...body.input, ...(body.items ? { items: body.items } : {}) };
}

// The controls row with a routine token (08 G12, RunInput.dc.html): its
// inline options (three at most), Show me only, When, More (the full run
// form), then Run.
export function InlineOptions({ routine, form, setForm, canRun, onRun }) {
  const [open, setOpen] = useState(null);
  const { inline } = splitOptions(optionsOf(routine));
  const toggle = (key) => setOpen(open === key ? null : key);
  const setOption = (key, value) => setForm({ ...form, options: { ...form.options, [key]: value } });
  return (
    <div className="eos-input__controls">
      {inline.map((o) => {
        const value = form.options[o.key] ?? o.default;
        if (o.type === "bool") {
          return <button key={o.key} type="button" className="eos-pill" aria-pressed={value === true} onClick={() => setOption(o.key, value !== true)}>{o.label}</button>;
        }
        if (o.type !== "choice") return null;
        return (
          <span key={o.key} className="eos-pill-wrap">
            <button type="button" className="eos-pill" aria-haspopup="menu" aria-expanded={open === o.key} onClick={() => toggle(o.key)}>
              <span className="eos-pill__label">{o.label}</span>{word(value)}<Chevron />
            </button>
            {open === o.key && (
              <ChoiceMenu label={o.label} items={(o.values ?? []).map((v) => ({ value: v, label: word(v) }))} value={value} onPick={(v) => { setOption(o.key, v); setOpen(null); }} />
            )}
          </span>
        );
      })}
      <button type="button" className="eos-pill" aria-pressed={form.result === "showOnly"} onClick={() => setForm({ ...form, result: form.result === "showOnly" ? "usual" : "showOnly" })}>
        Show me only
      </button>
      <span className="eos-pill-wrap">
        <button type="button" className="eos-pill eos-pill--bare" aria-expanded={open === "when"} onClick={() => toggle("when")}>
          {form.at != null ? whenWords(form.at, Date.now()) : "Now"}<Chevron />
        </button>
        {open === "when" && (
          <span className="eos-input__pop">
            <LaterPicker at={form.at} now={Date.now()} onChange={(at) => setForm({ ...form, at })} />
          </span>
        )}
      </span>
      <button type="button" className="eos-pill eos-pill--bare eos-pill--quiet" onClick={(e) => openRunSheet({ routineId: routine.id, anchor: e.currentTarget, input: sheetInput(routine, form) })}>
        More
      </button>
      <span className="eos-input__gap" />
      <button type="button" className="eos-input__send" aria-label="Run" disabled={!canRun} onClick={onRun}>
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" className="eos-input__icon" style={{ strokeWidth: 1.8 }}><path d="M8 12.5v-9M4.5 7L8 3.5 11.5 7" /></svg>
      </button>
    </div>
  );
}
