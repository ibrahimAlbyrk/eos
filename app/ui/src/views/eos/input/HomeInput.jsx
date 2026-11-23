import { useEffect, useRef } from "react";
import { setHomeDraft, useHomeDraft } from "../../../state/eos/homeDraftStore.js";
import { ThingChips } from "./ThingChips.jsx";
import { attachmentsOf } from "./things.js";
import { useThingIntake } from "./useThingIntake.js";

const Icon = ({ d, size = 15, width = 1.5 }) => (
  <svg aria-hidden="true" width={size} height={size} viewBox="0 0 16 16" className="eos-input__icon" style={{ strokeWidth: width }}>
    <path d={d} />
  </svg>
);

const editable = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

// The Home input card (Main.dc.html): the things handed to Eos, the text,
// and the controls row (Attach, then send). Entering Home never focuses it
// (08 G10): a click or `/` does. The text survives leaving Home. `onSubmit`
// gets { text, attachments } once the input knows what Enter does; without
// it, send stays off.
export function HomeInput({ onSubmit, onFocus, onBlur, inputRef: givenRef }) {
  const text = useHomeDraft();
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

  const ready = Boolean(onSubmit) && (text.trim() !== "" || things.length > 0) && things.every((t) => t.status === "ready");
  const submit = () => {
    if (!ready) return;
    onSubmit({ text: text.trim(), attachments: attachmentsOf(things) });
    setHomeDraft("");
    clear();
  };

  return (
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
          onChange={(e) => setHomeDraft(e.target.value)}
          onPaste={(e) => void onPaste(e)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
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
        <button type="button" className="eos-input__send" aria-label="Send" disabled={!ready} onClick={submit}>
          <Icon d="M8 12.5v-9M4.5 7L8 3.5 11.5 7" size={14} width={1.8} />
        </button>
      </div>
    </div>
  );
}
