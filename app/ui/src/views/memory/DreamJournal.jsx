import { useEffect, useRef, useState } from "react";
import { approveMemory, dismissMemory, updateMemory } from "../../state/userMemoryStore.js";
import { openDreamReview } from "../../state/dreamReviewStore.js";
import { setMemoryPage } from "../../state/memoryViewStore.js";
import {
  KIND_META, droppedTotal, evidenceOf, fmtDreamTime, kindCounts, modelLabel, proposalKind, scopeLine, supportLine,
} from "../../lib/dreamProposals.js";
import { projectLabel } from "../../lib/memoryGroups.js";
import { ConfidenceBars, EvidenceQuote, KindTag, MoonIcon, ProposalText } from "./DreamProposal.jsx";

const PenIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 20h4L19 9l-4-4L4 16z" />
  </svg>
);

function ProposalRow({ memory, memories }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(memory.text);
  const ref = useRef(null);
  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);
  const kind = proposalKind(memory);
  const ev = evidenceOf(memory);

  const save = () => {
    setEditing(false);
    const text = draft.trim();
    if (text && text !== memory.text) void updateMemory(memory.id, { text, baseRev: memory.rev });
  };

  return (
    <li className="dr-row">
      <span className="dr-row__tag"><KindTag kind={kind} /></span>
      <div className="dr-row__body">
        {editing ? (
          <textarea
            ref={ref}
            className="mem-item__edit dr-row__edit"
            value={draft}
            rows={2}
            maxLength={500}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); save(); }
              if (e.key === "Escape") { setDraft(memory.text); setEditing(false); }
            }}
          />
        ) : (
          <ProposalText memory={memory} memories={memories} />
        )}
        <span className="dr-row__meta">
          {ev[0] && <EvidenceQuote ev={ev[0]} compact />}
          {ev.length > 1 && <span>{ev.length} sources</span>}
          <span>{scopeLine(memory, memories)}</span>
          {supportLine(memory) ? <span>{supportLine(memory)}</span> : <ConfidenceBars value={memory.proposal?.confidence ?? 2} />}
        </span>
      </div>
      <div className="dr-row__actions">
        <button type="button" className="mem-btn mem-btn--primary" onClick={() => void approveMemory(memory.id)}>{KIND_META[kind].keep}</button>
        <button type="button" className="dr-icon-btn" aria-label="Edit before keeping" title="Edit before keeping" onClick={() => setEditing(true)}><PenIcon /></button>
        <button type="button" className="mem-btn mem-btn--ghost" onClick={() => void dismissMemory(memory.id)}>Dismiss</button>
      </div>
    </li>
  );
}

// A · Journal — the morning digest atop Memory: what the last dream read, the
// story of the night in a few sentences, and every pending proposal to keep, edit
// or dismiss in place. "Review one by one" opens the focused review.
export function DreamJournal({ proposals, memories, lastRun }) {
  if (!proposals.length) return null;
  const counts = kindCounts(proposals);
  const fromRun = lastRun && proposals.some((p) => p.source.dreamId === lastRun.id) ? lastRun : null;
  const projects = fromRun ? [...new Set(fromRun.chats.map((c) => (c.project ? projectLabel(c.project) : "no folder")))] : [];
  const dropped = fromRun ? droppedTotal(fromRun) : 0;
  const n = proposals.length;

  const keepRest = async () => {
    for (const p of proposals) await approveMemory(p.id);
  };

  return (
    <section className="dr-journal" aria-label="Dream journal">
      <span className="dr-stars" aria-hidden="true"><i /><i /><i /><i /></span>
      <header className="dr-journal__head">
        <span className="dr-journal__icon"><MoonIcon size={19} /></span>
        <div className="dr-journal__titles">
          <span className="dr-eyebrow">While you were away</span>
          <h2>{fromRun ? `Eos reread ${fromRun.chatsRead} ${fromRun.chatsRead === 1 ? "chat" : "chats"} and noticed ${n} ${n === 1 ? "thing" : "things"}` : `${n} ${n === 1 ? "thing" : "things"} from your dreams`}</h2>
          {fromRun?.narrative && <p>{fromRun.narrative}</p>}
          {fromRun && (
            <span className="dr-journal__meta">
              {[fmtDreamTime(fromRun.startedAt), projects.join(", "), modelLabel(fromRun.model), `~${Math.round(fromRun.tokens / 1000)}k tokens`].filter(Boolean).join(" · ")}
            </span>
          )}
        </div>
        <div className="dr-journal__cta">
          <button type="button" className="dr-btn-violet" onClick={openDreamReview}>Review one by one</button>
          <button type="button" className="mem-btn mem-btn--ghost" onClick={() => setMemoryPage("log")}>Dream log</button>
        </div>
      </header>

      <div className="dr-journal__chips">
        {counts.map((k) => <span key={k.kind} className={`dr-tag dr-tag--${k.kind}`}>{k.count} {k.label.toLowerCase()}</span>)}
        {dropped > 0 && <span className="dr-tag dr-tag--muted">{dropped} set aside</span>}
      </div>

      <div className="dr-sep" />
      <ul className="dr-journal__list">
        {proposals.map((p) => <ProposalRow key={p.id} memory={p} memories={memories} />)}
      </ul>

      <footer className="dr-journal__foot">
        {n > 1 && <button type="button" className="mem-btn mem-btn--soft" onClick={() => void keepRest()}>Keep all {n}</button>}
        <span>Dismissed ideas are never suggested again. Nothing changes until you keep it.</span>
      </footer>
    </section>
  );
}
