// Source ⇄ preview toggle for previewable files (markdown, html). Sits as the
// leftmost button in fv-actions; `.on` while preview is active, mirroring the
// Find toggle's state-based highlight.
export function PreviewToggle({ mode, onToggle }) {
  const isPreview = mode === "preview";
  return (
    <button
      className={"fv-icon-btn" + (isPreview ? " on" : "")}
      onClick={onToggle}
      title={isPreview ? "Show source" : "Show preview"}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8Z" />
        <circle cx="8" cy="8" r="1.75" />
      </svg>
    </button>
  );
}
