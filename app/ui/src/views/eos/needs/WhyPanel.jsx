import { useEffect, useState } from "react";
import { loadRecalled, notRightNote, recalledKey, useNotes } from "../../../state/eos/notesStore.js";
import { buildLocation, openLocation } from "../nav/eosNav.js";

const SAID_MAX = 200;

function Recalled({ note, runId }) {
  const [asking, setAsking] = useState(false);
  const [said, setSaid] = useState("");
  const [done, setDone] = useState(false);
  const send = async () => {
    if (await notRightNote(note.id, { runId, note: said.trim() })) setDone(true);
  };
  return (
    <li className="eos-needs-why__note">
      <button type="button" className="eos-needs-why__text" onClick={() => openLocation(buildLocation({ screen: "memory", tab: "work", note: note.id }))}>{note.text}</button>
      {note.why && <span className="eos-needs-why__from">{note.why}</span>}
      {done && <span className="eos-needs-why__from" role="status">Eos will lean on it less.</span>}
      {!done && !asking && <button type="button" className="eos-needs-why__not" onClick={() => setAsking(true)}>Not right</button>}
      {!done && asking && (
        <span className="eos-needs-why__ask">
          <input aria-label="What was wrong (optional)" placeholder="What was wrong? (optional)" maxLength={SAID_MAX} value={said} onChange={(e) => setSaid(e.target.value)} />
          <button type="button" className="eos-btn" onClick={() => void send()}>Send</button>
          <button type="button" className="eos-link" onClick={() => setAsking(false)}>Cancel</button>
        </span>
      )}
    </li>
  );
}

// Why a run's result looks the way it does: the notes Eos gave its agents,
// each with "Not right", which weakens it. Nothing when none came with it.
export function WhyPanel({ runId }) {
  const recalled = useNotes().recalled[recalledKey({ runId })];
  useEffect(() => void loadRecalled({ runId }), [runId]);
  const notes = [...new Map((recalled ?? []).map((n) => [n.row.id, n.row])).values()];
  if (notes.length === 0) return null;
  return (
    <section className="eos-needs-aside__part" aria-label="Why it looks like this">
      <h2 className="eos-label">Why it looks like this</h2>
      <p className="eos-needs-aside__lead">Eos remembered {notes.length === 1 ? "one thing" : `${notes.length} things`} from your earlier corrections:</p>
      <ul className="eos-needs-why">
        {notes.map((n) => <Recalled key={n.id} note={n} runId={runId} />)}
      </ul>
    </section>
  );
}
