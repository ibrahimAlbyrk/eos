import { useEffect, useRef, useState } from "react";
import { useRoutines } from "../../../state/eos/routinesStore.js";
import { editNote, forgetNote, loadNote, restoreNote, useNotes } from "../../../state/eos/notesStore.js";
import { LoadFailed, Loading } from "../capabilities/parts.jsx";
import { Fact } from "../frame.jsx";
import { buildLocation, openLocation } from "../nav/eosNav.js";
import { comesBackLine, dayOf, headline, helpLine, playbookLine, RESTORE_MS, sourceWord, whenOf } from "./words.js";

const TEXT_MAX = 280;
const CLOSE_ICON = "M4 4l8 8M12 4l-8 8";

// The note's words in a well, kept on Enter (Shift+Enter breaks the line),
// left on Escape; Cancel then Save at the right.
function EditForm({ note, onDone }) {
  const [text, setText] = useState(note.text);
  const [saving, setSaving] = useState(false);
  const field = useRef(null);
  useEffect(() => field.current?.focus(), []);
  const kept = text.trim();
  const can = !saving && kept && kept !== note.text;
  const save = async () => {
    if (!can) return;
    setSaving(true);
    const ok = await editNote(note.id, kept, note.rev);
    setSaving(false);
    if (ok) onDone();
  };
  const keys = (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onDone();
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void save();
    }
  };
  return (
    <div className="eos-mem-edit">
      <textarea ref={field} className="eos-mem-edit__text" aria-label="The note in your words" maxLength={TEXT_MAX} rows={3} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={keys} />
      <div className="eos-mem-edit__foot">
        <span className="eos-mem-edit__keys">Enter to save, Esc to cancel</span>
        <button type="button" className="eos-btn eos-btn--quiet" onClick={onDone}>Cancel</button>
        <button type="button" className="eos-btn eos-btn--primary" disabled={!can} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</button>
      </div>
    </div>
  );
}

function Part({ label, children }) {
  return (
    <section className="eos-mem-detail__part">
      <h3 className="eos-label">{label}</h3>
      {children}
    </section>
  );
}

// Did it help, as three figures: how often it came back, was used, helped.
function Help({ help }) {
  if (help.recalled === 0) return <p className="eos-mem-detail__para">{helpLine(help)}</p>;
  const figures = [["Came back", help.recalled], ["Used", help.used], ["Helped", help.helped], ...(help.hurt > 0 ? [["Was wrong", help.hurt]] : [])];
  return (
    <dl className="eos-mem-figures" aria-label={helpLine(help)}>
      {figures.map(([label, n]) => (
        <div key={label} className={label === "Was wrong" ? "eos-mem-figure eos-mem-figure--wrong" : "eos-mem-figure"}>
          <dd>{n}</dd>
          <dt>{label}</dt>
        </div>
      ))}
    </dl>
  );
}

// The aside of Eos › Memory: one note with what taught it, what it is about,
// when it comes back and what the agent then reads, whether it helped, and
// Edit and Forget. A forgotten note can be brought back for 30 days.
export function NoteDetail({ id }) {
  const { details, failed } = useNotes();
  const { list: routines } = useRoutines();
  const [editing, setEditing] = useState(false);
  useEffect(() => void loadNote(id), [id]);
  const detail = details[id];
  const close = () => openLocation(buildLocation({ screen: "memory", tab: "work" }));
  const closer = (
    <button type="button" className="eos-icon-btn eos-mem-detail__close" aria-label="Close the note" onClick={close}>
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d={CLOSE_ICON} /></svg>
    </button>
  );

  if (!detail) {
    let body = <Loading blocks={2} />;
    if (failed[id] === "gone") body = <Fact>This note is gone. It was forgotten more than 30 days ago, or never was.</Fact>;
    else if (failed[id] === "error") body = <LoadFailed what="the note" retry={() => void loadNote(id)} />;
    return <aside className="eos-card eos-mem-detail" aria-label="Note">{closer}{body}</aside>;
  }

  const { note } = detail;
  const gone = Boolean(note.forgottenAt);
  return (
    <aside className={gone ? "eos-card eos-mem-detail eos-mem-detail--forgotten" : "eos-card eos-mem-detail"} aria-label="Note">
      <header className="eos-mem-detail__head">
        <p className="eos-label eos-mem-detail__kind">{sourceWord(note.trust)}</p>
        {closer}
        {editing ? <EditForm note={note} onDone={() => setEditing(false)} /> : <h2 className="eos-mem-detail__text">{note.text}</h2>}
        <p className="eos-mem-detail__line">{headline(detail, routines)}</p>
        {playbookLine(detail) && <p className="eos-mem-detail__line">{playbookLine(detail)}</p>}
      </header>

      {gone && (
        <div className="eos-mem-gone" role="status">
          <Fact tone="warn">Forgotten. No agent reads it now. It can come back until {dayOf(note.forgottenAt + RESTORE_MS)}.</Fact>
          <button type="button" className="eos-btn eos-btn--primary" onClick={() => void restoreNote(id)}>Bring it back</button>
        </div>
      )}

      <div className="eos-mem-detail__body">
        {detail.learnedFrom.length > 0 && (
          <Part label="Learned from">
            <ol className="eos-mem-spine">
              {detail.learnedFrom.map((e, i) => (
                <li key={i} className="eos-mem-spine__step"><span className="eos-mem-detail__when">{whenOf(e.at)}</span> <span className="eos-mem-spine__text">{e.text}</span></li>
              ))}
            </ol>
          </Part>
        )}

        <Part label="Comes back when">
          <p className="eos-mem-detail__para">{comesBackLine(detail.comesBackWhen.situation)}</p>
          <blockquote className="eos-mem-detail__quote">{detail.comesBackWhen.reminder}</blockquote>
        </Part>

        <Part label="Did it help"><Help help={detail.help} /></Part>

        {detail.connectedTo.length > 0 && (
          <Part label="Connected to">
            <ul className="eos-mem-detail__chips">
              {detail.connectedTo.map((c) => <li key={`${c.kind}:${c.label}`} className="eos-chip">{c.label}</li>)}
            </ul>
          </Part>
        )}

        {detail.nextTo.length > 0 && (
          <Part label="Next to it">
            <ul className="eos-mem-next">
              {detail.nextTo.map((n) => (
                <li key={n.id}>
                  <button type="button" className="eos-mem-next__open" onClick={() => openLocation(buildLocation({ screen: "memory", tab: "work", note: n.id }))}>{n.text}</button>
                </li>
              ))}
            </ul>
          </Part>
        )}
      </div>

      {!gone && !editing && (
        <div className="eos-mem-detail__actions">
          <button type="button" className="eos-btn" onClick={() => setEditing(true)}>Edit</button>
          <button type="button" className="eos-btn eos-btn--ghost eos-btn--stop" onClick={() => void forgetNote(id)}>Forget</button>
        </div>
      )}
    </aside>
  );
}
