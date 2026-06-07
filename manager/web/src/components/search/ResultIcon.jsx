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
    case "template":
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9.5 1.5h-5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V4.5z" />
          <path d="M9.5 1.5V4.5h3" />
          <path d="M6 8.5h4M6 11h2.5" />
        </svg>
      );
    case "settings":
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      );
    case "diff":
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 2v6.5M5 8.5a2.5 2.5 0 0 0 2.5 2.5H11" />
          <circle cx="5" cy="13" r="1.6" />
          <path d="M11 8.5 13 11l-2 2.5M9 4.5h5" />
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
