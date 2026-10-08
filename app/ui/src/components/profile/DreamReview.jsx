import { useEffect, useMemo, useRef, useState } from "react";
import { useUserMemories, approveMemory, dismissMemory, updateMemory } from "../../state/userMemoryStore.js";
import { useDreams } from "../../state/dreamStore.js";
import {
  CONFIDENCE_LABEL, KIND_META, dreamProposals, evidenceOf, proposalKind, scopeLine, supportLine, whyOf,
} from "../../lib/dreamProposals.js";
import { ConfidenceBars, EvidenceQuote, KindTag, MoonIcon, ProposalText } from "../../views/memory/DreamProposal.jsx";

function Key({ k }) {
  return <kbd className="dr-kbd">{k}</kbd>;
}

// B · Triage — the morning review one proposal at a time, keyboard first: K keep ·
// E edit · D dismiss · → later · Esc done. The list is fixed when it opens, so
// decisions made elsewhere meanwhile don't shuffle what's on screen.
export function DreamReview({ onClose }) {
  const { memories } = useUserMemories();
  const { status } = useDreams();
  const [queue] = useState(() => dreamProposals(memories).map((m) => m.id));
  const [index, setIndex] = useState(0);
  const [decided, setDecided] = useState({});
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const rootRef = useRef(null);
  const editRef = useRef(null);
  useEffect(() => { rootRef.current?.focus(); }, []);
  useEffect(() => { if (editing) editRef.current?.focus(); }, [editing]);

  const byId = useMemo(() => new Map((memories ?? []).map((m) => [m.id, m])), [memories]);
  const finished = index >= queue.length;
  const current = finished ? null : byId.get(queue[index]);
  const lastRun = status?.lastRun;

  const next = (how) => {
    if (how) setDecided((d) => ({ ...d, [queue[index]]: how }));
    setEditing(false);
    setIndex((i) => i + 1);
  };
  const keep = () => { if (current) { void approveMemory(current.id); next("kept"); } };
  const dismiss = () => { if (current) { void dismissMemory(current.id); next("dismissed"); } };
  const startEdit = () => { if (current) { setDraft(current.text); setEditing(true); } };
  const saveEdit = () => {
    setEditing(false);
    const text = draft.trim();
    if (current && text && text !== current.text) void updateMemory(current.id, { text, baseRev: current.rev });
    rootRef.current?.focus();
  };

  // A proposal decided elsewhere (the journal, another window) is skipped over.
  useEffect(() => {
    if (!finished && !current) setIndex((i) => i + 1);
  }, [finished, current]);

  const onKeyDown = (e) => {
    if (editing || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "escape") { e.preventDefault(); onClose(); return; }
    if (finished) return;
    if (k === "k") { e.preventDefault(); keep(); }
    else if (k === "d") { e.preventDefault(); dismiss(); }
    else if (k === "e") { e.preventDefault(); startEdit(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); next(null); }
  };

  const kept = Object.values(decided).filter((x) => x === "kept").length;
  const dismissed = Object.values(decided).filter((x) => x === "dismissed").length;
  const later = queue.length - kept - dismissed;
  const kind = current ? proposalKind(current) : "new";
  const ev = current ? evidenceOf(current) : [];

  return (
    <div ref={rootRef} className="dr-review" role="dialog" aria-modal="true" aria-label="Morning review" tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="acc-welcome__drag" aria-hidden="true" />
      <header className="dr-review__top">
        <span className="dr-journal__icon dr-journal__icon--sm"><MoonIcon size={15} /></span>
        <span className="dr-review__title">
          <b>Morning review</b>
          <span>{lastRun ? `From the dream · ${lastRun.chatsRead} chats` : "From your dreams"}</span>
        </span>
        <span className="dr-review__progress" aria-label={`${Math.min(index + 1, queue.length)} of ${queue.length}`}>
          {queue.map((id, i) => <span key={id} className={`dr-review__seg${i < index ? " done" : i === index ? " now" : ""}`} />)}
        </span>
        <span className="dr-review__count mono">{Math.min(index + 1, queue.length)} of {queue.length}</span>
        <button type="button" className="acc-link acc-link--quiet" onClick={onClose}>Done for now</button>
      </header>

      {finished ? (
        <div className="dr-review__done">
          <span className="dr-journal__icon dr-journal__icon--lg"><MoonIcon size={22} /></span>
          <h1>That’s everything from the dream.</h1>
          <p>{kept} kept, {dismissed} dismissed{later ? `, ${later} left for later` : ""}. New agents start with what you kept.</p>
          <button type="button" className="acc-btn acc-btn--primary acc-btn--tall" onClick={onClose}>Back to Memory</button>
        </div>
      ) : current && (
        <div className="dr-review__body">
          <main className="dr-review__main" key={current.id}>
            <span className="dr-review__kicker"><KindTag kind={kind} /><span>{KIND_META[kind].kicker}</span></span>
            {editing ? (
              <textarea
                ref={editRef}
                className="dr-review__edit"
                value={draft}
                rows={3}
                maxLength={500}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={saveEdit}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); saveEdit(); }
                  if (e.key === "Escape") { e.stopPropagation(); setEditing(false); rootRef.current?.focus(); }
                }}
              />
            ) : (
              <ProposalText memory={current} memories={memories} large />
            )}
            <span className="dr-review__scope">{scopeLine(current, memories)} · {current.tier === "always" ? "Always on" : "On demand"}</span>
            <div className="dr-review__actions">
              <button type="button" className="dr-btn-violet dr-btn-violet--lg" onClick={keep}>{KIND_META[kind].keep}<Key k="K" /></button>
              <button type="button" className="dr-btn-quiet" onClick={startEdit}>Edit<Key k="E" /></button>
              <button type="button" className="dr-btn-quiet" onClick={dismiss}>Dismiss<Key k="D" /></button>
              <button type="button" className="dr-btn-quiet dr-btn-quiet--plain" onClick={() => next(null)}>Later<Key k="→" /></button>
            </div>
          </main>
          <aside className="dr-review__side">
            <section>
              <span className="dr-eyebrow">Why Eos thinks so</span>
              <span className="dr-review__conf">
                {supportLine(current) ?? (
                  <>
                    <ConfidenceBars value={current.proposal?.confidence ?? 2} />
                    {CONFIDENCE_LABEL[current.proposal?.confidence ?? 2]}
                  </>
                )}
              </span>
              {whyOf(current) && <span className="dr-review__why">Without it: {whyOf(current)}</span>}
              <span className="dr-review__why">
                {ev.length ? `Rests on ${ev.length} ${ev.length === 1 ? "message" : "messages"}${ev.some((e) => e.by === "user") ? ", in your own words" : ""}.` : "Drawn from memories you already kept."}
              </span>
            </section>
            {ev.length > 0 && (
              <section>
                <span className="dr-eyebrow">Evidence</span>
                <div className="dr-review__quotes">{ev.map((e, i) => <EvidenceQuote key={i} ev={e} onOpen={onClose} />)}</div>
              </section>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
