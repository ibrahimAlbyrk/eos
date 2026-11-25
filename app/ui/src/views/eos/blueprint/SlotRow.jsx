import { useState } from "react";
import { PartEditor } from "./slots/editors.jsx";

function Lock() {
  return (
    <svg className="eos-bp-lock" width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <rect x="3" y="7" width="10" height="7" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  );
}

// How a value is drawn: an agent as a card of its name over its model, a
// check as a pill, an adder as a dashed pill, a format as the line under
// the checks, any other value as a small chip in the sentence.
function partClass(part) {
  if (part.editor === "agent") return "eos-bp-agent";
  if (part.add) return "eos-bp-add";
  if (part.chip) return "eos-bp-chip";
  if (part.note) return "eos-bp-value eos-bp-value--note";
  return "eos-bp-value";
}

// One part of a slot's words. Read-only, a part is plain text and the parts
// that only add or remove are left out.
function Part({ part, editable, open, setOpen, apply }) {
  if (typeof part === "string") return part;
  if (part.break) return <span className="eos-bp-break" />;
  if (part.locked) return <span className="eos-bp-locked"><Lock />{part.text}<span className="eos-sr">, locked</span></span>;
  if (!editable) {
    if (part.editor === "act" || part.optional) return null;
    return <span className={part.editor === "agent" ? "eos-bp-agent" : part.chip ? "eos-bp-chip" : part.note ? "eos-bp-row__note" : undefined}>{part.text}{part.sub && <span className="eos-bp-chip__sub">{part.sub}</span>}</span>;
  }
  if (part.editor === "act") {
    return <button type="button" className={part.add ? "eos-bp-add" : "eos-bp-act"} aria-label={part.label} onClick={() => apply(part.apply())}>{part.text}</button>;
  }
  return (
    <button
      type="button"
      className={partClass(part)}
      aria-haspopup={part.editor === "menu" ? "menu" : "dialog"}
      aria-expanded={open}
      onClick={() => setOpen(open ? null : part.key)}
    >
      {part.text}{part.sub && <span className="eos-bp-chip__sub">{part.sub}</span>}
    </button>
  );
}

// The parts a read-only row shows: no adders or acts, and no line break
// that would only leave an empty line.
function readOnly(parts) {
  const kept = parts.filter((p) => typeof p === "string" || (p.editor !== "act" && !p.optional));
  return kept.filter((p, n) => !p.break || (n > 0 && n < kept.length - 1 && !kept[n + 1].break));
}

// The parts in groups of what may not part at a line's end: a remove
// button stays with the value before it, so it never wraps alone.
function grouped(parts) {
  const groups = [];
  for (const p of parts) {
    const prev = groups.at(-1);
    const removes = typeof p === "object" && p.editor === "act" && !p.add;
    if (removes && prev && typeof prev[0] === "object" && !prev[0].break) prev.push(p);
    else groups.push([p]);
  }
  return groups;
}

// The words a slot's state is named by beside its label; filled and empty
// say nothing, the mark and the line say it.
const STATE_WORD = { changed: "Changed", needs: "Needs you" };

// A row's class and its label's head: the mark on the blueprint's spine, the
// slot's name, and the word of its state. `state` is one of "empty"
// (nothing said yet), "writing" (the architect is at work), "filled",
// "changed" (differs from the version it is compared with) and "needs" (a
// finding of the core's names it).
export const rowClass = (state) => `eos-bp-row eos-bp-row--${state}`;

export function RowLabel({ label, state }) {
  return (
    <dt className="eos-bp-row__label">
      <span className="eos-bp-row__dot" aria-hidden="true" />
      <span className="eos-bp-row__name">{label}</span>
      {STATE_WORD[state] && <span className="eos-bp-row__mark">{STATE_WORD[state]}</span>}
    </dt>
  );
}

// A row of the blueprint card: the slot's name and its words. With `onApply`
// each value opens its own small editor, and a value chosen there
// becomes the slot's new value. `preview` goes under its words. A slot
// with nothing in it yet (`parts` null) says what it is for (`hint`)
// instead; while the architect writes, that line waits under a bar.
// `issues` are what the core's rules found wrong in this slot.
export function SlotRow({ label, parts, onApply, state = "filled", preview, hint, issues = [] }) {
  const [open, setOpen] = useState(null);
  const editable = Boolean(onApply) && parts !== null;
  const shown = parts === null ? [] : editable ? parts : readOnly(parts);
  const opened = editable && parts.find((p) => typeof p === "object" && p.key === open);
  const done = (value) => {
    setOpen(null);
    if (value !== undefined) onApply(opened.apply(value));
  };
  return (
    <div className={opened && opened.editor !== "recipient" && opened.editor !== "slack" ? `${rowClass(state)} eos-bp-row--editing` : rowClass(state)}>
      <RowLabel label={label} state={state} />
      <dd className="eos-bp-row__value">
        {parts === null && (
          <span className="eos-bp-row__hint">
            {state === "writing" && <span className="eos-bp-row__bar" aria-hidden="true" />}
            {hint}
          </span>
        )}
        {grouped(shown).map((group, n) => {
          const drawn = group.map((p, i) => (
            <Part key={typeof p === "object" && p.key ? p.key : `${n}.${i}`} part={p} editable={editable} open={open === p.key} setOpen={setOpen} apply={onApply} />
          ));
          return group.length > 1 ? <span key={n} className="eos-bp-keep">{drawn}</span> : drawn;
        })}
        {issues.length > 0 && <ul className="eos-bp-row__issues">{issues.map((line) => <li key={line}>{line}</li>)}</ul>}
        {opened && <PartEditor part={opened} done={done} />}
        {preview}
      </dd>
    </div>
  );
}
