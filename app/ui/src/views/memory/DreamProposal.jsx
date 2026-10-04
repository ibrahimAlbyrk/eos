import { useUi } from "../../state/ui.jsx";
import { CONFIDENCE_LABEL, KIND_META, proposalKind, targetsOf } from "../../lib/dreamProposals.js";

// The pieces every dream proposal is drawn from — shared by the journal rows and
// the one-at-a-time review.

export const MoonIcon = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
  </svg>
);

export function KindTag({ kind }) {
  return <span className={`dr-tag dr-tag--${kind}`}>{KIND_META[kind]?.label ?? kind}</span>;
}

export function ConfidenceBars({ value }) {
  const label = CONFIDENCE_LABEL[value] ?? "";
  return (
    <span className="dr-conf" role="img" aria-label={`${label} evidence`} title={`${label} evidence`}>
      {[1, 2, 3].map((k) => <span key={k} className={`dr-conf__bar${k <= value ? " on" : ""}`} />)}
    </span>
  );
}

// What changes: the old text(s) struck through, then the new one — or, for a
// retire, the memory struck through and why.
export function ProposalText({ memory, memories, large = false }) {
  const kind = proposalKind(memory);
  const targets = targetsOf(memory, memories);
  const cls = (base) => `${base}${large ? ` ${base}--lg` : ""}`;
  if (kind === "retire") {
    return (
      <>
        <p className={`${cls("dr-text")} is-retired`}>{targets[0]?.text ?? "A memory that's already gone"}</p>
        <p className={cls("dr-note")}>{memory.text}</p>
      </>
    );
  }
  const olds = kind === "update" || kind === "merge" ? targets.map((t) => t.text) : [];
  return (
    <>
      {olds.map((o, i) => <p key={i} className={cls("dr-old")}>{o}</p>)}
      <p className={cls("dr-text")}>{memory.text}</p>
    </>
  );
}

// One quoted message the proposal rests on; opens the chat it came from.
export function EvidenceQuote({ ev, compact = false, onOpen }) {
  const ui = useUi();
  return (
    <button
      type="button"
      className={`dr-quote${compact ? " dr-quote--compact" : ""}`}
      title="Open in chat"
      onClick={() => { onOpen?.(); ui.setActiveView("agents"); ui.selectAgent(ev.workerId); }}
    >
      <span className="dr-quote__text">“{ev.quote}”</span>
      {!compact && (
        <span className="dr-quote__meta">
          <span className={`dr-quote__dot${ev.by === "user" ? " is-user" : ""}`} />
          {ev.by === "user" ? "You" : "Agent"} · <span className="mono">{ev.chat}</span>
          <span className="dr-quote__open">Open in chat</span>
        </span>
      )}
    </button>
  );
}
