import { useState } from "react";
import { renderMarkdown } from "../../../lib/markdown.js";
import { clearNote, discardDraft, makeRoutine, NEW, sayToArchitect } from "../../../state/eos/blueprintStore.js";
import { useRoutines } from "../../../state/eos/routinesStore.js";
import { buildLocation, openLocation } from "../nav/eosNav.js";
import { SLOTS } from "./slots/index.js";

const SLOT_LABELS = Object.fromEntries([...SLOTS.map((s) => [s.key, s.label]), ["freedom", "Freedom"]]);

function Check({ children }) {
  return (
    <div className="eos-bp-check">
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M3 8.5l3 3 7-7" /></svg>
      {children}
    </div>
  );
}

// What the architect has done with the draft, in Eos's words.
export function checkLines(draft) {
  if (!draft) return [];
  const lines = [];
  const slots = draft.changed.filter((k) => SLOT_LABELS[k]);
  if (draft.draftVersionId && !draft.baseVersionId) lines.push("Wrote the blueprint");
  else if (draft.draftVersionId && slots.length) lines.push(`Changed ${slots.map((k) => SLOT_LABELS[k]).join(", ")}`);
  const n = draft.trialRuns.length;
  if (n) lines.push(`Ran a trial on ${n === 1 ? "one past item" : `${n} past items`}`);
  if (draft.status === "ready" && draft.draftVersionId) lines.push("The blueprint is ready for you to look at");
  return lines;
}

const WORKING = { working: "Working on the blueprint…", trying: "Trying it on real past items…" };

// The architect's one open question, with the answers it offers. Its words
// are an agent's, so they go through the sanitised markdown.
function Question({ routineId, draft }) {
  return (
    <div className="eos-bp-question">
      <p className="eos-label">One thing it could not tell from what you wrote</p>
      <div className="eos-bp-question__text" dangerouslySetInnerHTML={{ __html: renderMarkdown(draft.question) }} />
      {draft.choices.length > 0 && (
        <div className="eos-actions">
          {draft.choices.map((choice) => (
            <button key={choice} type="button" className="eos-btn" onClick={() => void sayToArchitect(routineId, { choice })}>{choice}</button>
          ))}
        </div>
      )}
    </div>
  );
}

// Too many architects at work: the core's words, and the drafts the user
// could leave to make room.
function Crowded({ routineId, text }) {
  const { list } = useRoutines();
  const others = (list ?? []).filter((r) => r.state === "draft" && r.id !== routineId);
  return (
    <div className="eos-band eos-band--warn" role="alert">
      <span className="eos-band__text">{text}</span>
      {others.map((r) => (
        <button key={r.id} type="button" className="eos-btn" onClick={async () => { if (await discardDraft(r.id)) clearNote(routineId); }}>
          Leave the draft of {r.name}
        </button>
      ))}
    </div>
  );
}

// Left of the blueprint card: the conversation with the routine's architect.
// The user's words are plain text; the input talks to the architect, or for
// a new routine, makes one from what the user wants. `draft` is the
// routine's DraftView, null when it has none; `routineId` is NEW for a new
// routine. `making`: the routine is still a draft, which has no head a
// change could start from, so without a draft of its architect's there is
// no one to talk to.
export function ArchitectChat({ routineId, draft, said = [], note, making = false }) {
  const [text, setText] = useState("");
  const isNew = routineId === NEW;
  const send = async (e) => {
    e.preventDefault();
    const words = text.trim();
    if (!words) return;
    setText("");
    if (!isNew) return void sayToArchitect(routineId, { text: words });
    const id = await makeRoutine(words);
    if (id) openLocation(buildLocation({ screen: "routine", routineId: id, tab: "blueprint" }));
  };
  const working = draft && WORKING[draft.status];
  return (
    <section className="eos-bp-chat" aria-label="Conversation with the architect">
      {draft?.purpose && <div className="eos-bp-bubble">{draft.purpose}</div>}
      {said.map((words, n) => <div key={n} className="eos-bp-bubble">{words}</div>)}
      {checkLines(draft).length > 0 && <div className="eos-bp-checks">{checkLines(draft).map((line) => <Check key={line}>{line}</Check>)}</div>}
      {working && <p className="eos-note" role="status">{working}</p>}
      {draft?.status === "abandoned" && <p className="eos-note">You left this draft. Say what to change to start again.</p>}
      {draft?.status === "asking" && draft.question && <Question routineId={routineId} draft={draft} />}
      {note?.kind === "crowded" && <Crowded routineId={routineId} text={note.text} />}
      <span className="eos-bp-chat__fill" />
      {making && draft === null ? (
        <p className="eos-note">This routine was made by hand. Change it on the card; once it runs, say what to change here.</p>
      ) : (
        <form className="eos-bp-say" onSubmit={send}>
          <input
            type="text"
            className="eos-bp-input"
            aria-label={isNew ? "Describe what Eos should take care of" : "Change the blueprint by describing it"}
            placeholder={isNew ? "Describe what Eos should take care of" : "Change anything by saying it"}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button type="submit" className="eos-btn eos-btn--primary">Send</button>
        </form>
      )}
    </section>
  );
}
