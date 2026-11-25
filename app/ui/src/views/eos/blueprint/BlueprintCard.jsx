import { useEffect, useState } from "react";
import { ensureCapabilitiesLoaded, useCapabilities } from "../../../state/eos/capabilitiesStore.js";
import { RoutineGlyph } from "../routines/RoutineGlyph.jsx";
import { FreedomLadder } from "./FreedomLadder.jsx";
import { SlotRow } from "./SlotRow.jsx";
import { TextEditor } from "./slots/editors.jsx";
import { SLOTS } from "./slots/index.js";
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

// The blueprint card: icon, name, sentence, what a run takes and the seven
// slots. With `onEdit` every value opens its editor and the
// changed blueprint goes to `onEdit`; without it the card is read-only.
// `changed` holds the slot keys to mark; `head` is the card's header line
// (the version menu), `children` what goes under the slots. With
// `routineId` the When and Which slots show their previews.
export function BlueprintCard({ blueprint, onEdit, changed = [], routines, head, routineId, children }) {
  const bp = blueprint ?? {};
  const capabilities = useCapabilities().list ?? [];
  useEffect(() => ensureCapabilitiesLoaded(), []);
  const put = (key) => (onEdit ? (value) => onEdit({ ...bp, [key]: value }) : undefined);
  const previews = routineId && {
    when: <SchedulePreview when={bp.when} />,
    which: <WhichPreview routineId={routineId} which={bp.which} />,
  };
  return (
    <section className="eos-card eos-bp-card" aria-label="Blueprint">
      {head && <div className="eos-bp-card__head">{head}</div>}
      <div className="eos-bp-card__title">
        <Glyph icon={bp.icon} name={bp.name} />
        <div className="eos-bp-card__words">
          <HeadText as="h2" className="eos-bp-card__name" label="Name" value={bp.name} empty="Not named yet" put={put("name")} />
          <HeadText as="p" className="eos-bp-card__sentence" label="What it does, in one sentence" value={bp.summary} empty="What it does, in one sentence" put={put("summary")} optional />
        </div>
      </div>
      <dl className="eos-bp-rows">
        {SLOTS.map((slot) => (
          <SlotRow key={slot.key} label={slot.label} parts={slot.parts(bp, { routines, capabilities })} onApply={put(slot.key)} changed={changed.includes(slot.key)} preview={previews?.[slot.key]} />
        ))}
        <FreedomLadder blueprint={bp} onApply={put("freedom")} changed={changed.includes("freedom")} routineId={routineId} />
      </dl>
      {children}
    </section>
  );
}
