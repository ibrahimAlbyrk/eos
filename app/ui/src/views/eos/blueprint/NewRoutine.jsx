import { useRef, useState } from "react";
import { createRoutine, NEW, useBlueprints } from "../../../state/eos/blueprintStore.js";
import { useRoutines } from "../../../state/eos/routinesStore.js";
import { EosHeader } from "../nav/EosHeader.jsx";
import { buildLocation, openLocation } from "../nav/eosNav.js";
import { BlueprintCard } from "./BlueprintCard.jsx";
import { FILE_ICON, ImportDialog, readChosen } from "./ImportRoutine.jsx";
import { NewRoutineStart } from "./NewRoutineStart.jsx";
import { Note } from "./BlueprintEditor.jsx";
import { HAND_BLUEPRINT } from "./words.js";

// eos:/routines/new (⌘N). First one question in the reading measure: what
// should Eos take care of; the words make the routine with its architect at
// work. "Fill it by hand" opens the blueprint card, every value editable,
// and Make it creates the routine as a draft. "Open a routine file", or a
// file dropped anywhere on the screen, asks in a dialog before it makes a
// draft of a routine file saved on any Mac. `say` (from Routines' starter
// sentences) is written in the input, ready to send. The drop veil covers the body
// only, so the header still says where the user is.
export function NewRoutine({ say }) {
  const picker = useRef(null);
  const { notes } = useBlueprints();
  const { list } = useRoutines();
  const [blueprint, setBlueprint] = useState(null);
  const note = notes[NEW];
  const opened = (id) => openLocation(buildLocation({ screen: "routine", routineId: id, tab: "blueprint" }));
  const make = async () => {
    const id = await createRoutine(blueprint);
    if (id) opened(id);
  };
  const [chosen, setChosen] = useState(null);
  const [dragging, setDragging] = useState(false);
  const fromFile = async (file) => {
    if (!file) return;
    setChosen(readChosen({ name: file.name, text: await file.text() }));
    if (picker.current) picker.current.value = "";
  };
  const carriesFile = (e) => [...(e.dataTransfer?.types ?? [])].includes("Files");
  return (
    <main
      className="eos-screen eos-screen--read eos-new-drop"
      onDragOver={(e) => {
        if (!carriesFile(e)) return;
        e.preventDefault();
        if (!dragging) setDragging(true);
      }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false); }}
      onDrop={(e) => {
        if (!carriesFile(e)) return;
        e.preventDefault();
        setDragging(false);
        void fromFile(e.dataTransfer.files?.[0]);
      }}
    >
      <EosHeader trail={[{ label: "Routines", location: "eos:/routines" }, { label: "New routine" }]}>
        {blueprint && <span className="eos-status">Draft, not running yet</span>}
      </EosHeader>
      <div className="eos-new__stage">
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
                  <p className="eos-bp-end__line">It is kept as a draft. Nothing runs until you start it.</p>
                  <div className="eos-bp-actions">
                    <button type="button" className="eos-btn eos-btn--primary" onClick={() => void make()}>Make it</button>
                    <button type="button" className="eos-btn eos-btn--ghost" onClick={() => setBlueprint(null)}>Describe it instead</button>
                  </div>
                </div>
              </BlueprintCard>
            </div>
          ) : (
            <NewRoutineStart say={say} note={note} onHand={() => setBlueprint(HAND_BLUEPRINT)} onFile={() => picker.current?.click()} />
          )}
          <input ref={picker} type="file" accept=".json,application/json" hidden aria-label="A routine file" onChange={(e) => void fromFile(e.target.files?.[0])} />
        </div>
        {dragging && (
          <div className="eos-new__veil" aria-hidden="true">
            <div className="eos-new__veil-box">
              <svg width="20" height="20" viewBox="0 0 16 16"><path d={FILE_ICON} /></svg>
              <p className="eos-new__veil-title">Drop a routine file to open it</p>
              <p className="eos-new__veil-line">It becomes a draft here. Nothing in it runs until you start it.</p>
            </div>
          </div>
        )}
      </div>
      {chosen && (
        <ImportDialog
          chosen={chosen}
          onClose={() => setChosen(null)}
          onMade={opened}
          onOther={() => {
            setChosen(null);
            picker.current?.click();
          }}
        />
      )}
    </main>
  );
}
