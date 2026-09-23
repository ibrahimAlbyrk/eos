// Glyphs shared by the Code view's sidebar, pane headers and launcher.

export function ClaudeGlyph({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M8 2v12M2 8h12M3.8 3.8l8.4 8.4M12.2 3.8l-8.4 8.4" />
    </svg>
  );
}

export function TerminalGlyph({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2" />
      <path d="m4.8 6.3 2 1.7-2 1.7M8.6 10h2.6" />
    </svg>
  );
}

export function FolderGlyph({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
      <path d="M2 4.6c0-.6.5-1.1 1.1-1.1h3l1.6 1.6h5.2c.6 0 1.1.5 1.1 1.1v6.1c0 .6-.5 1.1-1.1 1.1H3.1c-.6 0-1.1-.5-1.1-1.1z" />
    </svg>
  );
}

export function SplitRightGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <line x1="8" y1="3" x2="8" y2="13" />
    </svg>
  );
}

export function SplitDownGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <line x1="2" y1="8" x2="14" y2="8" />
    </svg>
  );
}

export function CloseGlyph({ size = 11 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

export function ChevronGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="m4 6 4 4 4-4" />
    </svg>
  );
}

export function KindGlyph({ kind, size }) {
  return kind === "shell" ? <TerminalGlyph size={size} /> : <ClaudeGlyph size={size} />;
}
