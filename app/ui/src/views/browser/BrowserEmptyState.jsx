// Shown in place of the live canvas when the active tab is blank (about:blank).
// A new tab does not auto-navigate anywhere, so this is the resting state until
// the human types a URL in the address bar above. Purely presentational — the
// address bar (BrowserNavBar) owns input; there is no field here. Uses the shared
// empty-state recipe (globe glyph + title + subtitle).
export function BrowserEmptyState() {
  return (
    <div className="empty-state">
      <span className="empty-state__icon">
        <svg
          width="46"
          height="46"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.1"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="9" />
          <ellipse cx="12" cy="12" rx="4" ry="9" />
          <path d="M3 12h18" />
          <path d="M4.6 7.5h14.8M4.6 16.5h14.8" />
        </svg>
      </span>
      <div className="empty-state__title">Browse and verify</div>
      <div className="empty-state__subtitle">Enter a URL above to start</div>
    </div>
  );
}
