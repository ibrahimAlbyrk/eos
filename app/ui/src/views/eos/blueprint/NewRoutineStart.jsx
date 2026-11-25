import { useRef, useState } from "react";
import { makeRoutine, NEW } from "../../../state/eos/blueprintStore.js";
import { Band, Section } from "../frame.jsx";
import { buildLocation, openLocation } from "../nav/eosNav.js";
import { Crowded } from "./ArchitectChat.jsx";
import { issueLine, NEW_STARTERS, SLOT_GUIDE } from "./words.js";

function Icon({ d }) {
  return (
    <svg className="eos-new__icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d={d} /></svg>
  );
}
const PEN = "M10.5 2.5l3 3L6 13H3v-3l7.5-7.5zM9 4l3 3";
const FILE = "M4 1.5h5L12.5 5v9.5h-8.5zM9 1.5V5h3.5M6.5 9.5L8 11l1.5-1.5M8 6.5V11";

// A new routine before anything is written: one question, asked as Home
// asks it, with sentences to start from; the two other ways in; and what a
// blueprint holds, so the user knows what Eos will write. `onHand` opens
// the card to fill by hand, `onFile` the file picker.
export function NewRoutineStart({ note, onHand, onFile }) {
  const [text, setText] = useState("");
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
      {note?.kind === "refused" && (
        <div className="eos-band eos-band--err" role="alert">
          <span className="eos-band__text">{note.text}</span>
          <ul className="eos-bp-issues">{note.issues.map((i) => <li key={issueLine(i)}>{issueLine(i)}</li>)}</ul>
        </div>
      )}

      <Section id="eos-new-other" label="Or start another way">
        <div className="eos-new__ways">
          <button type="button" className="eos-new__way" onClick={onHand}>
            <Icon d={PEN} />
            <span className="eos-new__waywords">
              <span className="eos-new__waytitle">Fill it by hand</span>
              <span className="eos-new__wayline">Set each part yourself, starting from one agent that reports to you.</span>
            </span>
          </button>
          <button type="button" className="eos-new__way" onClick={onFile}>
            <Icon d={FILE} />
            <span className="eos-new__waywords">
              <span className="eos-new__waytitle">From a file</span>
              <span className="eos-new__wayline">A routine file saved on another Mac, or one someone shared with you.</span>
            </span>
          </button>
        </div>
      </Section>

      <Section id="eos-new-holds" label="What a routine holds">
        <dl className="eos-new__guide">
          {SLOT_GUIDE.map(([label, line]) => (
            <div key={label} className="eos-new__part">
              <dt className="eos-new__partname">{label}</dt>
              <dd className="eos-new__partline">{line}</dd>
            </div>
          ))}
        </dl>
      </Section>
    </div>
  );
}
