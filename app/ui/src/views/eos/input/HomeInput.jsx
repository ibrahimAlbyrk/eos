import { useEffect, useRef } from "react";
import { CandidateList, LIST_ID } from "./CandidateList.jsx";
import { HomePills } from "./HomePills.jsx";
import { InlineOptions } from "./InlineOptions.jsx";
import { IntentLine } from "./IntentLine.jsx";
import { LiveRunLines } from "./LiveRunLines.jsx";
import { OnceResults } from "./OnceResult.jsx";
import { OutcomeLine } from "./OutcomeLine.jsx";
import { RoutineToken } from "./RoutineToken.jsx";
import { slotHint, usualLine } from "./runInput.js";
import { ThingChips } from "./ThingChips.jsx";
import { useHomeInput } from "./useHomeInput.js";

const Icon = ({ d, size = 15, width = 1.5 }) => (
  <svg aria-hidden="true" width={size} height={size} viewBox="0 0 16 16" className="eos-input__icon" style={{ strokeWidth: width }}>
    <path d={d} />
  </svg>
);

const editable = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

// The line under the card: a refusal of the last act, the run the routine
// token starts, or the intent line.
function UnderLine({ h, idleHint }) {
  if (h.acts.outcome) return <OutcomeLine outcome={h.acts.outcome} again={() => h.enter()} />;
  if (h.line) {
    return (
      <div className="eos-intent">
        <div className="eos-intent__line">
          {h.line.enter && <span className="eos-intent__key" aria-hidden="true">↵</span>}
          <span className={h.line.enter ? "eos-intent__text" : "eos-intent__text eos-intent__text--note"}>{h.line.text}</span>
        </div>
        <span className="eos-sr" aria-live="polite">{h.line.text}</span>
      </div>
    );
  }
  return <IntentLine intent={h.intent} byId={h.byId} onMenu={() => h.onChange("/")} idleHint={idleHint} />;
}

// The Home input (Main.dc.html, RunInput.dc.html, RunIntent.dc.html): the
// things handed to Eos and the text, or a routine token with its item slot;
// the controls row (Attach, the freedom, project and model pills and send,
// or the token's options and Run); the
// line that says what Enter will do; the `/` menu or the token's
// candidates; then the runs it started and the tasks done once. Entering
// Home never focuses it (08 G10): a click or `/` does. The text survives
// leaving Home.
export function HomeInput({ onFocus, onBlur, inputRef: givenRef, blockRef, held, door, idleHint }) {
  const cardRef = useRef(null);
  const ownRef = useRef(null);
  const inputRef = givenRef ?? ownRef;
  const fileRef = useRef(null);
  const h = useHomeInput(cardRef, { held, door });
  const { things, dragging, onPaste, addFiles, remove } = h.intake;

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || editable(document.activeElement)) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inputRef]);

  const routine = h.routine;
  const items = routine && h.form ? (routine.takes?.many ? h.form.items : h.form.item ? [h.form.item] : []) : [];
  const listOpen = h.rows.length > 0;
  const label = routine?.takes?.label;
  const removeItem = (item) => h.setForm(routine.takes.many ? { ...h.form, items: h.form.items.filter((i) => i !== item) } : { ...h.form, item: null });
  return (
    <div ref={blockRef} className="eos-input-block">
      <div ref={cardRef} className={dragging ? "eos-input eos-input--drop" : "eos-input"}>
        <div className="eos-input__line">
          <ThingChips things={things} onRemove={remove} />
          {routine && <RoutineToken routine={routine} items={items} onRemove={() => h.pick(null)} onRemoveItem={removeItem} />}
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            className="eos-input__text"
            autoComplete="off"
            aria-label={routine ? (label ? `Which ${label}` : `A note for ${routine.name}`) : "Tell Eos what to take care of"}
            aria-expanded={listOpen}
            aria-controls={LIST_ID}
            aria-autocomplete="list"
            aria-activedescendant={listOpen && h.list.active >= 0 ? `${LIST_ID}-${h.list.active}` : undefined}
            placeholder={routine ? slotHint(routine.takes) : "What should Eos take care of?"}
            value={h.text}
            onChange={(e) => h.onChange(e.target.value)}
            onPaste={(e) => void onPaste(e)}
            onKeyDown={h.onKeyDown}
            onFocus={(e) => { h.setFocused(true); onFocus?.(e); }}
            onBlur={(e) => { h.setFocused(false); onBlur?.(e); }}
          />
        </div>
        {routine && h.form ? (
          <InlineOptions routine={routine} form={h.form} setForm={h.setForm} canRun={h.canSend} onRun={h.enter} />
        ) : (
          <div className="eos-input__controls">
            <button type="button" className="eos-input__round" aria-label="Attach" onClick={() => fileRef.current?.click()}>
              <Icon d="M8 3.5v9M3.5 8h9" />
            </button>
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                addFiles([...e.target.files]);
                e.target.value = "";
              }}
            />
            <HomePills intent={h.intent.chosen?.intent} choices={h.choices} setChoices={h.setChoices} />
            <button type="button" className="eos-input__send" aria-label="Send" disabled={!h.canSend} onClick={h.enter}>
              <Icon d="M8 12.5v-9M4.5 7L8 3.5 11.5 7" size={14} width={1.8} />
            </button>
          </div>
        )}
      </div>
      <UnderLine h={h} idleHint={idleHint} />
      <CandidateList
        title={routine ? `Open ${label ?? "item"}s` : "Your routines"}
        rows={h.rows}
        active={h.list.active}
        onChoose={h.choose}
        foot={routine ? usualLine(routine, h.plan) : null}
      />
      <LiveRunLines byId={h.byId} />
      <OnceResults />
    </div>
  );
}
