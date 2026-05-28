// Maps a provider's icon key to an SVG, decoupling result rendering from the
// pure-data providers. Add a case here when a new provider needs a new glyph.
export function ResultIcon({ name }) {
  switch (name) {
    case "workflow":
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
          <circle cx="4" cy="4" r="1.8" />
          <circle cx="4" cy="12" r="1.8" />
          <circle cx="12" cy="8" r="1.8" />
          <path d="M5.8 4h2.7a2 2 0 0 1 2 2v.3M5.8 12h2.7a2 2 0 0 0 2-2v-.3" />
        </svg>
      );
    case "agent":
    default:
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 6 2.5 8 5 10M11 6l2.5 2L11 10" />
          <path d="M9.2 4.5 6.8 11.5" />
        </svg>
      );
  }
}
