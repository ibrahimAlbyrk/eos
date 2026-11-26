import { useEffect } from "react";
import { loadRecalled, recalledKey, useNotes } from "../../../state/eos/notesStore.js";
import { buildLocation, openLocation } from "../nav/eosNav.js";
import { word } from "../routines/tableWords.js";

const SHOWN = 3;

const count = (n) => (n === 1 ? "One note" : `${word(n)} notes`);

// The memory a run's agents were given before they started: the first
// notes, each opening in Memory, and how many there were in all.
export function RunMemory({ runId }) {
  const recalled = useNotes().recalled[recalledKey({ runId })];
  useEffect(() => void loadRecalled({ runId }), [runId]);
  const notes = [...new Map((recalled ?? []).map((n) => [n.row.id, n.row])).values()];
  if (notes.length === 0) return null;
  const open = (note) => openLocation(buildLocation({ screen: "memory", tab: "work", note }));
  return (
    <section className="eos-run-aside__part" aria-label="Memory that came with it">
      <h2 className="eos-label">Memory that came with it</h2>
      <ul className="eos-run-memory">
        {notes.slice(0, SHOWN).map((n) => (
          <li key={n.id}><button type="button" className="eos-run-memory__note" onClick={() => open(n.id)}>{n.text}</button></li>
        ))}
      </ul>
      {notes.length > SHOWN && (
        <button type="button" className="eos-link eos-link--quiet" onClick={() => open(undefined)}>{count(notes.length)} in all</button>
      )}
    </section>
  );
}
