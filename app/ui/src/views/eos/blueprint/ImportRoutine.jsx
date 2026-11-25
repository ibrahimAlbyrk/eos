import { useState } from "react";
import { importRoutineFile, readRoutineFile } from "../../../state/eos/routinesStore.js";
import { AskRows, Dialog } from "../frame.jsx";
import { numberWord } from "../home/homeWords.js";

export const FILE_ICON = "M4 1.5h5L12.5 5v9.5h-8.5zM9 1.5V5h3.5M6.5 9.5L8 11l1.5-1.5M8 6.5V11";

const versionsWord = (n) => (n === 1 ? "One version" : `${numberWord(n).replace(/^./, (c) => c.toUpperCase())} versions`);

// What a chosen or dropped routine file asks for: `{ name, text }` read into
// what it holds, shown before anything is sent.
export const readChosen = ({ name, text }) => ({ fileName: name, read: readRoutineFile(text) });

// A routine file asks before it becomes a draft: which file, the routine it
// holds and its versions, Cancel first and Make the draft last. A file that
// is no routine says so and offers another. `onMade(id)` opens the draft,
// `onOther` the file picker again.
export function ImportDialog({ chosen, onClose, onMade, onOther }) {
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(null);
  const { fileName, read } = chosen;
  const make = async () => {
    if (busy) return;
    setBusy(true);
    const done = await importRoutineFile(read.file);
    setBusy(false);
    if (done.id) onMade(done.id);
    else setRefused(done.error);
  };
  const other = (
    <>
      <button type="button" className="eos-btn eos-btn--ghost" autoFocus onClick={onClose}>Cancel</button>
      <button type="button" className="eos-btn" onClick={onOther}>Choose another file</button>
    </>
  );
  if (!read) {
    return (
      <Dialog
        id="eos-import"
        from="A routine file"
        icon={FILE_ICON}
        title="This file is not a routine."
        line="Eos opens the .json file a routine's Save to a file writes. Choose another one."
        onClose={onClose}
        actions={other}
      >
        <AskRows rows={[["File", <span key="f" className="eos-ask__mono">{fileName}</span>]]} />
      </Dialog>
    );
  }
  return (
    <Dialog
      id="eos-import"
      from="A routine file"
      icon={FILE_ICON}
      title={read.name ? `Make a draft of ${read.name}?` : "Make a draft from this file?"}
      line="It arrives as a draft on this Mac. Nothing in it runs, sends or earns freedom until you try it and start it."
      onClose={onClose}
      actions={refused ? other : (
        <>
          <button type="button" className="eos-btn eos-btn--ghost" autoFocus onClick={onClose}>Cancel</button>
          <button type="button" className="eos-btn eos-btn--primary" disabled={busy} onClick={() => void make()}>{busy ? "Making the draft…" : "Make the draft"}</button>
        </>
      )}
    >
      <AskRows
        rows={[
          ["File", <span key="f" className="eos-ask__mono">{fileName}</span>],
          ...(read.name ? [["Routine", read.name]] : []),
          ...(read.versions ? [["Versions", versionsWord(read.versions)]] : []),
        ]}
      />
      {refused && <p className="eos-ask__wrong" role="alert">{refused.replace(/^./, (c) => c.toUpperCase())}. Nothing was made.</p>}
    </Dialog>
  );
}
