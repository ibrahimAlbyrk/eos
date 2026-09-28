// A provider's tile: a tinted square with a simple stroke mark (never a brand
// logo), plus an optional status dot in the corner. `size` is the tile edge in px.

const MARKS = {
  anthropic: <path d="M12 3.5v17M3.5 12h17M6 6l12 12M18 6L6 18" />,
  openai: <><path d="M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9z" /><circle cx="12" cy="12" r="3.2" /></>,
  gemini: <path d="M12 3c.9 4.9 3.9 7.9 9 9-5.1 1.1-8.1 4.1-9 9-.9-4.9-3.9-7.9-9-9 5.1-1.1 8.1-4.1 9-9z" />,
  xai: <path d="M5 5l14 14M19 5L5 19" />,
  deepseek: <path d="M2.5 12c2.4-3.2 5.1-3.2 7.5 0s5.1 3.2 7.5 0c1.2-1.6 2.6-2.2 4-1.8" />,
  moonshot: <path d="M16 4.5a8 8 0 1 0 4 12.5A7 7 0 0 1 16 4.5z" />,
  qwen: <path d="M12 3l9 9-9 9-9-9z" />,
  zhipu: <path d="M12 4.5l8 14.5H4z" />,
};

export function ProviderGlyph({ id, size = 36, tone = null, dim = false }) {
  const known = id in MARKS;
  return (
    <span
      className={`acc-glyph acc-glyph--${known ? id : "other"}${dim ? " is-dim" : ""}`}
      style={{ "--g": `${size}px` }}
      aria-hidden="true"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        {known ? MARKS[id] : <circle cx="12" cy="12" r="6" />}
      </svg>
      {tone && <span className={`acc-glyph__dot is-${tone}`} />}
    </span>
  );
}
