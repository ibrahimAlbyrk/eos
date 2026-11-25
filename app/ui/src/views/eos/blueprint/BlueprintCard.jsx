import { useEffect, useState } from "react";
import { ensureCapabilitiesLoaded, useCapabilities } from "../../../state/eos/capabilitiesStore.js";
import { RoutineGlyph } from "../routines/RoutineGlyph.jsx";
import { FreedomLadder } from "./FreedomLadder.jsx";
import { SlotRow } from "./SlotRow.jsx";
import { slotHint } from "./words.js";
import { TextEditor } from "./slots/editors.jsx";
import { slotIsEmpty, SLOTS } from "./slots/index.js";
import { SchedulePreview, WhichPreview } from "./slots/Previews.jsx";

// The routine's own glyph, as the sidebar and the field draw it.
function Glyph({ icon, name }) {
  return (
    <span className="eos-bp-card__icon" aria-hidden="true">
      <RoutineGlyph icon={icon} name={name || "R"} size={19} part="eos-bp-card" />
    </span>
  );
}

// The name or the sentence: text, or with `put` a button opening its editor.
// Read-only, an `optional` one left empty says nothing.
function HeadText({ as: Tag, className, label, value, empty, put, optional = false }) {
  const [open, setOpen] = useState(false);
  if (!put) return value || !optional ? <Tag className={className}>{value || empty}</Tag> : null;
  return (
    <>
      <Tag className={className}>
        <button type="button" className="eos-bp-headvalue" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>{value || empty}</button>
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

// The findings of the core's rules on slot `key`, by the first step of
// their path, each said by its message.
export const issuesOf = (issues, key) => issues.filter((i) => i.path?.[0] === key).map((i) => i.message);

// What a slot is doing, as its mark on the spine draws it: a finding names
// it, the architect is writing it, it differs from what it is compared
// with, it says nothing yet, or it is filled.
export function slotState(key, bp, { changed = [], issues = [], writing = false } = {}) {
  if (issuesOf(issues, key).length) return "needs";
  if (writing && bp[key] === undefined) return "writing";
  if (changed.includes(key)) return "changed";
  return slotIsEmpty(key, bp) ? "empty" : "filled";
}

// The blueprint card: icon, name, sentence and the version line at its top,
// then the eight slots on one spine, each with the mark of its state. With
// `onEdit` every value opens its editor and the changed blueprint goes to
// `onEdit`; without it the card is read-only. `changed` holds the slot keys
// to mark; `issues` are the core's findings, each said under its slot; with `writing` the slots not
// written yet wait for the architect. `head` is the version line, `children`
// what goes under the slots. With `routineId` the When and Which slots show
// their previews.
// With `ghost` it is the outline of one not written yet: no ground, no
// title, only the spine and what each slot holds.
export function BlueprintCard({ blueprint, onEdit, changed = [], issues = [], writing = false, ghost = false, routines, head, routineId, children }) {
  const bp = blueprint ?? {};
  const capabilities = useCapabilities().list ?? [];
  useEffect(() => ensureCapabilitiesLoaded(), []);
  const put = (key) => (onEdit ? (value) => onEdit({ ...bp, [key]: value }) : undefined);
  const previews = routineId && {
    when: <SchedulePreview when={bp.when} />,
    which: <WhichPreview routineId={routineId} which={bp.which} />,
  };
  const marks = { changed, issues, writing };
  return (
    <section className={ghost ? "eos-bp-card eos-bp-card--ghost" : writing ? "eos-card eos-bp-card eos-bp-card--writing" : "eos-card eos-bp-card"} aria-label="Blueprint" aria-busy={writing || undefined}>
      {!ghost && <div className="eos-bp-card__title">
        <Glyph icon={bp.icon} name={bp.name} />
        <div className="eos-bp-card__words">
          <HeadText as="h2" className="eos-bp-card__name" label="Name" value={bp.name} empty="Not named yet" put={put("name")} />
          <HeadText as="p" className="eos-bp-card__sentence" label="What it does, in one sentence" value={bp.summary} empty="What it does, in one sentence" put={put("summary")} optional />
        </div>
        {head && <div className="eos-bp-card__head">{head}</div>}
      </div>}
      <dl className="eos-bp-rows">
        {SLOTS.map((slot) => (
          <SlotRow
            key={slot.key}
            label={slot.label}
            parts={bp[slot.key] === undefined ? null : slot.parts(bp, { routines, capabilities })}
            hint={slotHint(slot.label)}
            onApply={put(slot.key)}
            state={slotState(slot.key, bp, marks)}
            preview={bp[slot.key] === undefined ? undefined : previews?.[slot.key]}
            issues={issuesOf(issues, slot.key)}
          />
        ))}
        <FreedomLadder blueprint={bp} onApply={put("freedom")} state={slotState("freedom", bp, marks)} hint={slotHint("Freedom")} routineId={routineId} />
      </dl>
      {children}
    </section>
  );
}
