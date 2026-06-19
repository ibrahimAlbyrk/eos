// Source ⇄ preview toggle for previewable files (markdown, html). Leftmost
// button in fv-actions; the glyph swaps with the mode — an eye to enter preview,
// a code-bracket </> to go back to source — so it reads as a normal icon-button
// beside its siblings (no .on highlight; the icon itself carries the state).
export function PreviewToggle({ mode, onToggle }) {
  const isPreview = mode === "preview";
  return (
    <button
      className="fv-icon-btn"
      onClick={onToggle}
      title={isPreview ? "Show source" : "Show preview"}
    >
      {isPreview ? (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="m5.5 5-3 3 3 3" />
          <path d="m10.5 5 3 3-3 3" />
          <path d="m9.25 4-2.5 8" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8Z" />
          <circle cx="8" cy="8" r="1.75" />
        </svg>
      )}
    </button>
  );
}
