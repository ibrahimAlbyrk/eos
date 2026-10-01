// Outline glyphs (16px grid, 1.5 stroke). Tool rows are text-only now; only the
// spinner is still used (Environment panel's "active subagents" row).
const PATHS = {
  spin: <path d="M8 1.75A6.25 6.25 0 1 1 1.75 8" />,
};

export function ToolIcon({ name, className = "" }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}
