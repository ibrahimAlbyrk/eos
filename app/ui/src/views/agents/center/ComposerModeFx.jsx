// Git / bash mode entrance for the composer card: a color wash blooms out of the
// mode orb, a lit edge wraps the bottom-left corner, and a soft tint stays.
// Callers key both on the mode so switching modes replays the animation.

export function ModeFx() {
  return (
    <div className="mode-fx" aria-hidden>
      <span className="mode-bloom" />
      <span className="mode-tint" />
      <span className="mode-edge" />
    </div>
  );
}

export function ModeOrb({ mode }) {
  return (
    <span className="mode-orb" aria-hidden>
      {mode === "term" ? "❯" : (
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="4.5" cy="3.5" r="1.5" />
          <circle cx="4.5" cy="12.5" r="1.5" />
          <circle cx="11.5" cy="5" r="1.5" />
          <path d="M4.5 5v6M11.5 6.5c0 2.2-2.7 2.6-4.5 3.2" />
        </svg>
      )}
    </span>
  );
}
