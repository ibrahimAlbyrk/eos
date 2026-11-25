import { useEffect } from "react";
import { loadNotes, notesPath, useNotes } from "../../../state/eos/notesStore.js";
import { buildLocation, openLocation } from "../nav/eosNav.js";
import { provenance } from "../memory/words.js";

const SHOWN = 4;

// The scope of the notes a routine learned, as Memory filters them.
export const routineScope = (routineId) => `routine:${routineId}`;

// What it learned from you: the routine's first notes, each with why Eos
// holds it, and All, its Learned tab. Nothing until it has learned something.
export function WhatItLearned({ routineId }) {
  const path = notesPath({ scope: routineScope(routineId) });
  const page = useNotes().pages[path];
  useEffect(() => void loadNotes(path), [path]);
  if (!page?.notes.length) return null;
  const open = (id) => openLocation(buildLocation({ screen: "memory", tab: "work", note: id }));
  return (
    <section className="eos-routine__section" aria-label="What it learned from you">
      <header className="eos-routine__head">
        <h2 className="eos-label">What it learned from you</h2>
        <button type="button" className="eos-link eos-link--quiet" onClick={() => openLocation(buildLocation({ screen: "routine", routineId, tab: "learned" }))}>All</button>
      </header>
      <ul className="eos-learned">
        {page.notes.slice(0, SHOWN).map((row) => (
          <li key={row.id}>
            <button type="button" className="eos-learned__open" onClick={() => open(row.id)}>
              <span className="eos-learned__text">{row.text}</span>
              <span className="eos-learned__why">{provenance(row)}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
