import { useRef, useState } from "react";
import { createRoutine, NEW, useBlueprints } from "../../../state/eos/blueprintStore.js";
import { importRoutine, useRoutines } from "../../../state/eos/routinesStore.js";
import { EosHeader } from "../nav/EosHeader.jsx";
import { buildLocation, openLocation } from "../nav/eosNav.js";
import { ArchitectChat } from "./ArchitectChat.jsx";
import { BlueprintCard, OutlineCard } from "./BlueprintCard.jsx";
import { issueLine, HAND_BLUEPRINT } from "./words.js";

// eos:/routines/new (⌘N): an empty conversation that makes the routine from
// what the user describes, beside the card in outline. "Fill it by hand"
// makes each slot editable here; Make it creates the routine as a draft.
// "From a file" makes a draft of a routine file saved on any Mac.
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
    <main className="eos-screen">
      <EosHeader trail={[{ label: "Routines", location: "eos:/routines" }, { label: "New routine" }]}>
        <span className="eos-status">Draft, not running yet</span>
      </EosHeader>
      <div className="eos-body">
        <div className="eos-bp">
          <ArchitectChat routineId={NEW} draft={null} note={note} />
          <div className="eos-bp__side">
            {note?.kind === "refused" && (
              <div className="eos-band eos-band--err" role="alert">
                <span className="eos-band__text">{note.text}</span>
                <ul className="eos-bp-issues">{note.issues.map((i) => <li key={issueLine(i)}>{issueLine(i)}</li>)}</ul>
              </div>
            )}
            {blueprint ? (
              <BlueprintCard blueprint={blueprint} onEdit={setBlueprint} routines={list}>
                <div className="eos-bp-actions">
                  <button type="button" className="eos-btn eos-btn--primary" onClick={() => void make()}>Make it</button>
                </div>
              </BlueprintCard>
            ) : (
              <OutlineCard>
                <div className="eos-bp-actions">
                  <button type="button" className="eos-btn" onClick={() => setBlueprint(HAND_BLUEPRINT)}>Fill it by hand</button>
                  <button type="button" className="eos-btn" onClick={() => picker.current?.click()}>From a file</button>
                  <input ref={picker} type="file" accept=".json,application/json" hidden aria-label="A routine file" onChange={(e) => void fromFile(e.target.files?.[0])} />
                </div>
              </OutlineCard>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
