import { useRef, useState } from "react";
import { createRoutine, NEW, useBlueprints } from "../../../state/eos/blueprintStore.js";
import { importRoutine, useRoutines } from "../../../state/eos/routinesStore.js";
import { EosHeader } from "../nav/EosHeader.jsx";
import { buildLocation, openLocation } from "../nav/eosNav.js";
import { BlueprintCard } from "./BlueprintCard.jsx";
import { NewRoutineStart } from "./NewRoutineStart.jsx";
import { Note } from "./BlueprintEditor.jsx";
import { HAND_BLUEPRINT } from "./words.js";

// eos:/routines/new (⌘N). First one question in the reading measure: what
// should Eos take care of; the words make the routine with its architect at
// work. "Fill it by hand" opens the blueprint card, every value editable,
// and Make it creates the routine as a draft. "From a file" makes a draft
// of a routine file saved on any Mac.
export function NewRoutine() {
  const picker = useRef(null);
  const { notes } = useBlueprints();
  const { list } = useRoutines();
  const [blueprint, setBlueprint] = useState(null);
  const note = notes[NEW];
  const make = async () => {
    const id = await createRoutine(blueprint);
    if (id) openLocation(buildLocation({ screen: "routine", routineId: id, tab: "blueprint" }));
  };
  const fromFile = async (file) => {
    if (!file) return;
    const id = await importRoutine(await file.text());
    if (id) openLocation(buildLocation({ screen: "routine", routineId: id, tab: "blueprint" }));
  };
  return (
    <main className="eos-screen eos-screen--read">
      <EosHeader trail={[{ label: "Routines", location: "eos:/routines" }, { label: "New routine" }]}>
        {blueprint && <span className="eos-status">Draft, not running yet</span>}
      </EosHeader>
      <div className="eos-body">
        {blueprint ? (
          <div className="eos-new eos-new--hand">
            <div className="eos-new__head">
              <p className="eos-label">By hand</p>
              <h2 className="eos-lead">Set each part, then make it.</h2>
              <p className="eos-lead__sub">Click any value to change it. Each mark on the left fills as its part is said.</p>
            </div>
            {note?.kind === "refused" && <Note note={note} />}
            <BlueprintCard blueprint={blueprint} onEdit={setBlueprint} routines={list} issues={note?.kind === "refused" ? note.issues : []}>
              <div className="eos-bp-end">
                <p className="eos-bp-end__line">It is kept as a draft. A trial and Start come next, and nothing runs before them.</p>
                <div className="eos-bp-actions">
                  <button type="button" className="eos-btn eos-btn--primary" onClick={() => void make()}>Make it</button>
                  <button type="button" className="eos-btn eos-btn--ghost" onClick={() => setBlueprint(null)}>Describe it instead</button>
                </div>
              </div>
            </BlueprintCard>
          </div>
        ) : (
          <NewRoutineStart note={note} onHand={() => setBlueprint(HAND_BLUEPRINT)} onFile={() => picker.current?.click()} />
        )}
        <input ref={picker} type="file" accept=".json,application/json" hidden aria-label="A routine file" onChange={(e) => void fromFile(e.target.files?.[0])} />
      </div>
    </main>
  );
}
