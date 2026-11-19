import { useState } from "react";
import { FreedomLadder } from "./FreedomLadder.jsx";
import { SlotRow } from "./SlotRow.jsx";
import { TextEditor } from "./slots/editors.jsx";
import { SLOTS } from "./slots/index.js";

function Glyph() {
  return (
    <span className="eos-bp-card__icon" aria-hidden="true">
      <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><circle cx="8" cy="8" r="5.5" /><circle cx="8" cy="8" r="1.5" /></svg>
    </span>
  );
}

// The name or the sentence: text, or with `put` a button opening its editor.
function HeadText({ as: Tag, className, label, value, empty, put }) {
  const [open, setOpen] = useState(false);
  if (!put) return <Tag className={className}>{value || empty}</Tag>;
  return (
    <>
      <Tag className={className}>
        <button type="button" className="eos-bp-value" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>{value || empty}</button>
      </Tag>
      {open && (
        <TextEditor
          part={{ label, value }}
          done={(next) => {
            setOpen(false);
            if (next !== undefined && next) put(next);
          }}
        />
      )}
    </>
  );
}

// The blueprint card: icon, name, sentence, what a run takes and the seven
// slots. With `onEdit` every underlined value opens its editor and the
// changed blueprint goes to `onEdit`; without it the card is read-only.
// `changed` holds the slot keys to mark; `head` is the card's header line
// (the version menu), `children` what goes under the slots.
export function BlueprintCard({ blueprint, onEdit, changed = [], routines, head, children }) {
  const bp = blueprint ?? {};
  const put = (key) => (onEdit ? (value) => onEdit({ ...bp, [key]: value }) : undefined);
  return (
    <section className="eos-card eos-bp-card" aria-label="Blueprint">
      {head && <div className="eos-bp-card__head">{head}</div>}
      <div className="eos-bp-card__title">
        <Glyph />
        <div>
          <HeadText as="h2" className="eos-bp-card__name" label="Name" value={bp.name} empty="Not named yet" put={put("name")} />
          <HeadText as="p" className="eos-bp-card__sentence" label="What it does, in one sentence" value={bp.summary} empty="What it does, in one sentence" put={put("summary")} />
        </div>
      </div>
      <dl className="eos-bp-rows">
        {SLOTS.map((slot) => (
          <SlotRow key={slot.key} label={slot.label} parts={slot.parts(bp, { routines })} onApply={put(slot.key)} changed={changed.includes(slot.key)} />
        ))}
        <FreedomLadder blueprint={bp} onApply={put("freedom")} changed={changed.includes("freedom")} />
      </dl>
      {children}
    </section>
  );
}

// A new routine's card before anything is written: each slot in outline.
export function OutlineCard({ children }) {
  return (
    <section className="eos-card eos-bp-card eos-bp-card--outline" aria-label="Blueprint">
      <div className="eos-bp-card__title"><Glyph /><div><h2 className="eos-bp-card__name">New routine</h2></div></div>
      <dl className="eos-bp-rows">
        {[...SLOTS.map((s) => s.label), "Freedom"].map((label) => (
          <div key={label} className="eos-bp-row"><dt className="eos-bp-row__label">{label}</dt><dd className="eos-bp-row__value eos-bp-row__value--empty">Not set yet</dd></div>
        ))}
      </dl>
      {children}
    </section>
  );
}
