import { useEffect, useMemo, useRef } from "react";
import { setHomeDraft, useHomeDraft } from "../../../state/eos/homeDraftStore.js";
import { useRoutines } from "../../../state/eos/routinesStore.js";
import { useIntent } from "./intent/useIntent.js";
import { IntentLine } from "./IntentLine.jsx";
import { ThingChips } from "./ThingChips.jsx";
import { useThingIntake } from "./useThingIntake.js";

const Icon = ({ d, size = 15, width = 1.5 }) => (
  <svg aria-hidden="true" width={size} height={size} viewBox="0 0 16 16" className="eos-input__icon" style={{ strokeWidth: width }}>
    <path d={d} />
  </svg>
);

const editable = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

// The Home input card (Main.dc.html): the things handed to Eos, the text,
// the controls row (Attach, then send) and under it the intent line, which
// always says what Enter will do (RunIntent.dc.html). Entering Home never
// focuses it (08 G10): a click or `/` does. The text survives leaving Home.
// `onAct(choice, { text, attachments })` does what Enter chose; without it,
// send stays off.
export function HomeInput({ onAct, onFocus, onBlur, inputRef: givenRef }) {
  const text = useHomeDraft();
  const routines = useRoutines().list;
  const byId = useMemo(() => new Map((routines ?? []).map((r) => [r.id, r])), [routines]);
  const cardRef = useRef(null);
  const ownRef = useRef(null);
  const inputRef = givenRef ?? ownRef;
  const fileRef = useRef(null);
  const { things, dragging, onPaste, addFiles, remove, clear } = useThingIntake(cardRef);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || editable(document.activeElement)) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inputRef]);

  const intent = useIntent({
    text,
    things,
    routines,
    onAct: (choice, given) => {
      if (choice.intent === "menu") return setHomeDraft("/");
      onAct(choice, given);
      setHomeDraft("");
      clear();
    },
  });
  const ready = Boolean(onAct) && things.every((t) => t.status === "ready");
  const canSend = ready && (intent.chosen !== null || intent.verdict.kind === "waiting");
  const enter = () => { if (ready) intent.enter(); };

  return (
    <div className="eos-input-block">
      <div ref={cardRef} className={dragging ? "eos-input eos-input--drop" : "eos-input"}>
        <div className="eos-input__line">
          <ThingChips things={things} onRemove={remove} />
          <input
            ref={inputRef}
            type="text"
            className="eos-input__text"
            aria-label="Tell Eos what to take care of"
            placeholder="What should Eos take care of?"
            value={text}
            onChange={(e) => {
              setHomeDraft(e.target.value);
              intent.dispatch({ type: "typed" });
            }}
            onPaste={(e) => void onPaste(e)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                enter();
              } else if (e.key === "Tab" && !e.altKey && !e.metaKey && intent.tab(e.shiftKey ? -1 : 1)) {
                e.preventDefault();
              }
            }}
            onFocus={onFocus}
            onBlur={onBlur}
          />
        </div>
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
          <span className="eos-input__gap" />
          <button type="button" className="eos-input__send" aria-label="Send" disabled={!canSend} onClick={enter}>
            <Icon d="M8 12.5v-9M4.5 7L8 3.5 11.5 7" size={14} width={1.8} />
          </button>
        </div>
      </div>
      <IntentLine intent={intent} byId={byId} onMenu={() => { setHomeDraft("/"); inputRef.current?.focus(); }} />
    </div>
  );
}
