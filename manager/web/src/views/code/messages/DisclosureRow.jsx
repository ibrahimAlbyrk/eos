// Shared expand/collapse header. Owns the disclosure affordance — content-sized
// hit-area, hover pill, chevron, keyboard toggle — so callers only provide the
// row content (verb/file/stats spans). expandable=false renders a plain,
// non-interactive row (no cursor, no chevron).
export function DisclosureRow({ expanded, onToggle, expandable = true, className = "", children }) {
  const cls = "disclosure-row" + (className ? ` ${className}` : "");
  if (!expandable) return <div className={cls}>{children}</div>;
  return (
    <div
      className={cls}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        onToggle();
      }}
    >
      {children}
      <svg className="ti-chev" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="m6 4 4 4-4 4" />
      </svg>
    </div>
  );
}
