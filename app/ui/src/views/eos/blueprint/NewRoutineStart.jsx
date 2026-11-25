import { useRef, useState } from "react";
import { makeRoutine, NEW } from "../../../state/eos/blueprintStore.js";
import { Band, Section } from "../frame.jsx";
import { buildLocation, openLocation } from "../nav/eosNav.js";
import { Crowded } from "./ArchitectChat.jsx";
import { BlueprintCard } from "./BlueprintCard.jsx";
import { Note } from "./BlueprintEditor.jsx";
import { NEW_STARTERS } from "./words.js";

function Icon({ d }) {
  return (
    <svg className="eos-new__icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d={d} /></svg>
  );
}
const PEN = "M10.5 2.5l3 3L6 13H3v-3l7.5-7.5zM9 4l3 3";
const FILE = "M4 1.5h5L12.5 5v9.5h-8.5zM9 1.5V5h3.5M6.5 9.5L8 11l1.5-1.5M8 6.5V11";

// A new routine before anything is written: one question, asked as Home
// asks it, with sentences to start from; the two other ways in on one quiet
// line; and the blueprint Eos will write, its eight slots empty on their
// spine, each saying what it holds. `onHand` opens the card to fill by
// hand, `onFile` the file picker.
export function NewRoutineStart({ say, note, onHand, onFile }) {
  const [text, setText] = useState(say ?? "");
  const [sending, setSending] = useState(false);
  const field = useRef(null);
  const send = async (e) => {
    e?.preventDefault();
    const words = text.trim();
    if (!words || sending) return;
    setSending(true);
    const id = await makeRoutine(words);
    setSending(false);
    if (id) openLocation(buildLocation({ screen: "routine", routineId: id, tab: "blueprint" }));
  };
  const pick = (words) => {
    setText(words);
    field.current?.focus();
  };
  return (
    <div className="eos-new">
      <header className="eos-new__head">
        <p className="eos-label">New routine</p>
        <h2 className="eos-new__ask">What should Eos take care of?</h2>
        <p className="eos-new__sub">Say it the way you would tell a colleague. Eos writes the blueprint and tries it on real past items. Nothing runs until you say so.</p>
      </header>

      <form className="eos-input eos-new__input" onSubmit={send}>
        <textarea
          ref={field}
          autoFocus={say !== undefined}
          className="eos-input__text eos-new__text"
          rows={2}
          aria-label="Describe what Eos should take care of"
          placeholder="Every weekday at nine, review the pull requests waiting for me"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) void send(e);
          }}
        />
        <div className="eos-input__controls">
          <span className="eos-new__keys">{sending ? "Writing the blueprint…" : "Enter to send, Shift Enter for a new line"}</span>
          <span className="eos-input__gap" />
          <button type="submit" className="eos-input__send" aria-label="Send" disabled={!text.trim() || sending}>
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" className="eos-input__icon" style={{ strokeWidth: 1.8 }}><path d="M8 12.5v-9M4.5 7L8 3.5 11.5 7" /></svg>
          </button>
        </div>
      </form>

      <div className="eos-starters">
        {NEW_STARTERS.map((words) => (
          <button key={words} type="button" className="eos-starter" onClick={() => pick(words)}>{words}</button>
        ))}
      </div>

      {note?.kind === "crowded" && <Crowded routineId={NEW} text={note.text} drafts={note.drafts} />}
      {note?.kind === "refusal" && <Band tone="err" role="alert">{note.text}</Band>}
      {note?.kind === "refused" && <Note note={note} />}

      <p className="eos-new__ways">
        <span className="eos-new__or">Or</span>
        <button type="button" className="eos-new__way eos-new__hand" onClick={onHand}>
          <Icon d={PEN} />Fill it in by hand
        </button>
        <span className="eos-new__sep" aria-hidden="true">·</span>
        <button type="button" className="eos-new__way" onClick={onFile}>
          <Icon d={FILE} />Open a routine file
        </button>
      </p>

      <Section id="eos-new-holds" label="The blueprint Eos will write" aside="Eight parts, each yours to change">
        <BlueprintCard blueprint={{}} ghost />
      </Section>
    </div>
  );
}
