import { useMemo, useState } from "react";
import { useWorkerEvents } from "../../../hooks/useWorkerEvents.js";
import { renderMarkdown } from "../../../lib/markdown.js";
import { buildBlocks } from "../../../lib/messageParser.js";
import { clearNote, discardDraft, makeRoutine, NEW, sayToArchitect } from "../../../state/eos/blueprintStore.js";
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
          {draft.choices.map((choice, n) => (
            <button key={choice} type="button" className={n === 0 ? "eos-btn eos-btn--primary" : "eos-btn"} onClick={() => void sayToArchitect(routineId, { choice })}>{choice}</button>
          ))}
        </div>
      )}
    </div>
  );
}

// What the architect itself wrote, oldest first, from its session's event
// rows. Its prompts are Eos's, so only its own text is shown.
export function architectReplies(events) {
  return buildBlocks(events).filter((b) => b.kind === "assistant" && b.text?.trim()).map((b) => ({ key: b.blockId ?? b.rowId ?? b.ts, text: b.text }));
}

// The architect's words as its session writes them: on screen, its events
// stream to this tab as Agents' transcript does. An agent's words, so they
// go through the sanitised markdown.
function Replies({ workerId }) {
  const { events, eventsFor } = useWorkerEvents(workerId);
  const replies = useMemo(() => (eventsFor === workerId ? architectReplies(events) : []), [events, eventsFor, workerId]);
  return replies.map((r) => <div key={r.key} className="eos-bp-reply" dangerouslySetInnerHTML={{ __html: renderMarkdown(r.text) }} />);
}

// Too many architects at work, and the drafts the user could leave to make
// room: those whose architects are at work, as the refusal named them.
export function Crowded({ routineId, text, drafts }) {
  const others = drafts.filter((r) => r.id !== routineId);
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
  const quiet = !making && !draft && said.length === 0 && !note;
  return (
    <section className="eos-bp-chat" aria-label="Conversation with the architect">
      {!isNew && <h2 className="eos-label eos-bp-chat__label">The architect</h2>}
      {draft?.purpose && <div className="eos-bp-bubble">{draft.purpose}</div>}
      {said.map((words, n) => <div key={n} className="eos-bp-bubble">{words}</div>)}
      {draft?.architectId && <Replies workerId={draft.architectId} />}
      {checkLines(draft).length > 0 && <div className="eos-bp-checks">{checkLines(draft).map((line) => <Check key={line}>{line}</Check>)}</div>}
      {working && <p className="eos-note" role="status">{working}</p>}
      {draft?.status === "abandoned" && <p className="eos-note">You left this draft. Say what to change to start again.</p>}
      {draft?.status === "asking" && draft.question && <Question routineId={routineId} draft={draft} />}
      {note?.kind === "crowded" && <Crowded routineId={routineId} text={note.text} drafts={note.drafts} />}
      {note?.kind === "refusal" && <p className="eos-note" role="alert">{note.text}</p>}
      {quiet && (
        <p className="eos-bp-chat__hint">
          {isNew
            ? "Say in your own words what Eos should take care of, and it writes the blueprint here. Or fill it in by hand."
            : "Say what to change. Eos writes a new version beside this one, and nothing changes until you use it."}
        </p>
      )}
      <span className="eos-bp-chat__fill" />
      {making && draft === null ? (
        <p className="eos-note">This routine was made by hand. Change it on the card; once it runs, say what to change here.</p>
      ) : (
        <form className="eos-tell__bar eos-bp-say" onSubmit={send}>
          <input
            type="text"
            className="eos-tell__input"
            aria-label={isNew ? "Describe what Eos should take care of" : "Change the blueprint by describing it"}
            placeholder={isNew ? "Describe what Eos should take care of" : "Change anything by saying it"}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button type="submit" className="eos-tell__send" aria-label="Send" disabled={!text.trim()}>
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16"><path d="M8 12.5v-9M4.5 7L8 3.5 11.5 7" /></svg>
          </button>
        </form>
      )}
    </section>
  );
}
