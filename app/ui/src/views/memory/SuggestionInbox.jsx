import { approveAllMemories, approveMemory, dismissMemory } from "../../state/userMemoryStore.js";
import { projectLabel } from "../../lib/memoryGroups.js";

const SparkIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
    <path d="M19 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" />
  </svg>
);

// What agents suggested and the user hasn't decided on. Nothing here reaches a
// prompt until it's kept.
export function SuggestionInbox({ pending }) {
  if (!pending.length) return null;
  const n = pending.length;
  return (
    <section className="mem-inbox" aria-label="Suggested memories">
      <header className="mem-inbox__head">
        <span className="mem-inbox__icon"><SparkIcon /></span>
        <span className="mem-inbox__title">
          <b>{n === 1 ? "An agent noticed something" : `Agents noticed ${n} things`}</b>
          <span>Nothing is remembered until you keep it.</span>
        </span>
        {n > 1 && <button type="button" className="mem-btn mem-btn--soft" onClick={() => void approveAllMemories()}>Keep all</button>}
      </header>
      <div className="mem-inbox__grid">
        {pending.map((m) => (
          <article key={m.id} className="mem-suggestion">
            <p className="mem-suggestion__text">{m.text}</p>
            {m.source.kind === "agent" && m.source.why && <p className="mem-suggestion__why">“{m.source.why}”</p>}
            <div className="mem-suggestion__meta">
              {m.source.kind === "agent" && <span className="mem-tag mem-tag--agent">{m.source.agentName}</span>}
              <span className="mem-tag">{m.scope.kind === "project" ? projectLabel(m.scope.path) : "All projects"}</span>
            </div>
            <div className="mem-suggestion__actions">
              <button type="button" className="mem-btn mem-btn--primary" onClick={() => void approveMemory(m.id)}>Keep</button>
              <button type="button" className="mem-btn mem-btn--ghost" onClick={() => void dismissMemory(m.id)}>Dismiss</button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
