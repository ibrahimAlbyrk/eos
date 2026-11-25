import { useEffect, useState } from "react";
import { useRoutines } from "../../../state/eos/routinesStore.js";
import { editNote, forgetNote, loadNote, restoreNote, useNotes } from "../../../state/eos/notesStore.js";
import { LoadFailed, Loading } from "../capabilities/parts.jsx";
import { buildLocation, openLocation } from "../nav/eosNav.js";
import { comesBackLine, dayOf, headline, helpLine, playbookLine, RESTORE_MS, whenOf } from "./words.js";

const TEXT_MAX = 280;

function EditForm({ note, onDone }) {
  const [text, setText] = useState(note.text);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    const kept = await editNote(note.id, text.trim(), note.rev);
    setSaving(false);
    if (kept) onDone();
  };
  return (
    <div className="eos-mem-edit">
      <textarea className="eos-mem-edit__text" aria-label="The note in your words" maxLength={TEXT_MAX} rows={3} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="eos-mem-detail__actions">
        <button type="button" className="eos-btn eos-btn--primary" disabled={saving || !text.trim() || text.trim() === note.text} onClick={() => void save()}>Save</button>
        <button type="button" className="eos-btn" onClick={onDone}>Cancel</button>
      </div>
    </div>
  );
}

function Section({ label, children }) {
  return (
    <section className="eos-mem-detail__part">
      <h3 className="eos-label">{label}</h3>
      {children}
    </section>
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

  if (!detail) {
    let body = <Loading blocks={2} />;
    if (failed[id] === "gone") body = <p className="eos-note">This note is gone.</p>;
    else if (failed[id] === "error") body = <LoadFailed what="the note" retry={() => void loadNote(id)} />;
    return <aside className="eos-card eos-mem-detail" aria-label="Note">{body}</aside>;
  }

  const { note } = detail;
  const close = () => openLocation(buildLocation({ screen: "memory", tab: "work" }));
  return (
    <aside className="eos-card eos-mem-detail" aria-label="Note">
      <header className="eos-mem-detail__head">
        {editing ? <EditForm note={note} onDone={() => setEditing(false)} /> : <h2 className="eos-mem-detail__text">{note.text}</h2>}
        <p className="eos-mem-detail__line">{headline(detail, routines)}</p>
        {playbookLine(detail) && <p className="eos-mem-detail__line">{playbookLine(detail)}</p>}
      </header>

      {note.forgottenAt && (
        <div className="eos-band eos-band--warn">
          <span className="eos-band__text">Forgotten. It can come back until {dayOf(note.forgottenAt + RESTORE_MS)}.</span>
          <button type="button" className="eos-btn" onClick={() => void restoreNote(id)}>Bring it back</button>
        </div>
      )}

      {detail.learnedFrom.length > 0 && (
        <Section label="Learned from">
          <ol className="eos-mem-detail__list">
            {detail.learnedFrom.map((e, i) => (
              <li key={i}><span className="eos-mem-detail__when">{whenOf(e.at)}</span> {e.text}</li>
            ))}
          </ol>
        </Section>
      )}

      {detail.connectedTo.length > 0 && (
        <Section label="Connected to">
          <ul className="eos-mem-detail__chips">
            {detail.connectedTo.map((c) => <li key={`${c.kind}:${c.label}`} className="eos-chip">{c.label}</li>)}
          </ul>
        </Section>
      )}

      {detail.nextTo.length > 0 && (
        <p className="eos-mem-detail__next">
          Next to it:{" "}
          {detail.nextTo.map((n, i) => (
            <span key={n.id}>
              {i > 0 && ", "}
              <button type="button" className="eos-link eos-link--quiet" onClick={() => openLocation(buildLocation({ screen: "memory", tab: "work", note: n.id }))}>{n.text}</button>
            </span>
          ))}
        </p>
      )}

      <Section label="Comes back when">
        <p className="eos-mem-detail__para">{comesBackLine(detail.comesBackWhen.situation)}</p>
        <blockquote className="eos-mem-detail__quote">{detail.comesBackWhen.reminder}</blockquote>
      </Section>

      <Section label="Did it help">
        <p className="eos-mem-detail__para">{helpLine(detail.help)}</p>
      </Section>

      {!note.forgottenAt && !editing && (
        <div className="eos-mem-detail__actions">
          <button type="button" className="eos-btn" onClick={() => setEditing(true)}>Edit</button>
          <button type="button" className="eos-btn eos-btn--ghost eos-btn--stop" onClick={() => void forgetNote(id)}>Forget</button>
          <button type="button" className="eos-btn eos-btn--quiet eos-mem-detail__close" onClick={close}>Close</button>
        </div>
      )}
    </aside>
  );
}
