import { useScrollHold } from "./scrollHoldContext.js";

// Shared expand/collapse header. Owns the disclosure affordance — content-sized
// hit-area, hover pill, chevron, keyboard toggle — so callers only provide the
// row content (verb/file/stats spans). expandable=false renders a plain,
// non-interactive row (no cursor, no chevron).
export function DisclosureRow({ expanded, onToggle, expandable = true, className = "", children }) {
  const hold = useScrollHold();
  const cls = "disclosure-row" + (className ? ` ${className}` : "");
  if (!expandable) return <div className={cls}>{children}</div>;
  // Expanding grows content downward — hold the scroller so it doesn't glide.
  // Collapsing shrinks; the bottom clamp already does the right thing.
  const toggle = () => {
    if (!expanded) hold();
    onToggle();
  };
  return (
    <div
      className={cls}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      // mouse clicks must not leave the row focused — any later keypress (e.g.
      // Esc closing a viewer) flips WebKit to keyboard modality and paints a
      // lingering :focus-visible ring; Tab focus + Enter/Space stay intact
      onMouseDown={(e) => e.preventDefault()}
      onClick={toggle}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        toggle();
      }}
    >
      {children}
      <svg className="ti-chev" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="m6 4 4 4-4 4" />
      </svg>
    </div>
  );
}
