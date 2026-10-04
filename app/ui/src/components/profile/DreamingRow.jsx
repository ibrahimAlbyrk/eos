const MoonIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
    <path d="M16 3.5v3M14.5 5h3" />
  </svg>
);

// Dreaming — background review of finished chats that files memory suggestions.
// Not built yet: the row announces it with a disabled, off switch (no config behind
// it). Shared by Settings › Profile and the Memory view.
export function DreamingRow({ compact = false }) {
  return (
    <div className={`prof-dream${compact ? " prof-dream--compact" : ""}`}>
      {!compact && <span className="prof-dream__icon"><MoonIcon /></span>}
      <div className="prof-dream__text">
        <div className="prof-dream__label">Dreaming<span className="prof-soon">Soon</span></div>
        <div className="prof-dream__desc">
          {compact
            ? "Review finished chats while you're away"
            : "While you're away, agents look back over finished chats and suggest what's worth remembering. You still approve every one."}
        </div>
      </div>
      <button type="button" role="switch" aria-checked="false" aria-label="Dreaming (coming soon)" disabled className="stg-toggle prof-dream__toggle">
        <span className="stg-toggle__knob" />
      </button>
    </div>
  );
}
