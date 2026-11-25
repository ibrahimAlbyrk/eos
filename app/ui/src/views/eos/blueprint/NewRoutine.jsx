import { useRef, useState } from "react";
import { createRoutine, NEW, useBlueprints } from "../../../state/eos/blueprintStore.js";
import { importRoutine, useRoutines } from "../../../state/eos/routinesStore.js";
import { EosHeader } from "../nav/EosHeader.jsx";
import { buildLocation, openLocation } from "../nav/eosNav.js";
import { BlueprintCard } from "./BlueprintCard.jsx";
import { NewRoutineStart } from "./NewRoutineStart.jsx";
import { issueLine, HAND_BLUEPRINT } from "./words.js";

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
        <span className="eos-status">Draft, not running yet</span>
      </EosHeader>
      <div className="eos-body">
        {blueprint ? (
          <div className="eos-new eos-new--hand">
            <div className="eos-new__head">
              <p className="eos-label">By hand</p>
              <h2 className="eos-lead">Set each part, then make it.</h2>
              <p className="eos-lead__sub">Click any value to change it. The routine is kept as a draft and runs only when you start it.</p>
            </div>
            {note?.kind === "refused" && (
              <div className="eos-band eos-band--err" role="alert">
                <span className="eos-band__text">{note.text}</span>
                <ul className="eos-bp-issues">{note.issues.map((i) => <li key={issueLine(i)}>{issueLine(i)}</li>)}</ul>
              </div>
            )}
            <BlueprintCard blueprint={blueprint} onEdit={setBlueprint} routines={list}>
              <div className="eos-bp-actions">
                <button type="button" className="eos-btn eos-btn--primary" onClick={() => void make()}>Make it</button>
                <button type="button" className="eos-btn eos-btn--quiet" onClick={() => setBlueprint(null)}>Describe it instead</button>
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
