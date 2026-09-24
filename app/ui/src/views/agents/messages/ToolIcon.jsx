// Outline glyphs for tool rows (16px grid, 1.5 stroke). A tool view names its
// glyph via `icon` in toolViews.jsx; unknown names fall back to "tool".
const PATHS = {
  file: <><path d="M9 1.75H4.5A1.75 1.75 0 0 0 2.75 3.5v9a1.75 1.75 0 0 0 1.75 1.75h7a1.75 1.75 0 0 0 1.75-1.75V6L9 1.75Z" /><path d="M9 1.75V6h4.25" /></>,
  filePlus: <><path d="M9 1.75H4.5A1.75 1.75 0 0 0 2.75 3.5v9a1.75 1.75 0 0 0 1.75 1.75h7a1.75 1.75 0 0 0 1.75-1.75V6L9 1.75Z" /><path d="M8 7.75v4.5M5.75 10h4.5" /></>,
  pencil: <><path d="M11.25 2.25a1.77 1.77 0 0 1 2.5 2.5L5.5 13 2 14l1-3.5 8.25-8.25Z" /><path d="m10 3.5 2.5 2.5" /></>,
  terminal: <><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2.25" /><path d="m4.75 6.25 2 1.75-2 1.75M8.75 10.25h2.5" /></>,
  search: <><circle cx="7" cy="7" r="4.25" /><path d="m10.25 10.25 3.5 3.5" /></>,
  folder: <path d="M1.75 4.5a1.75 1.75 0 0 1 1.75-1.75h2.6l1.5 1.5h4.9a1.75 1.75 0 0 1 1.75 1.75v5.5a1.75 1.75 0 0 1-1.75 1.75h-9a1.75 1.75 0 0 1-1.75-1.75v-7Z" />,
  globe: <><circle cx="8" cy="8" r="6.25" /><path d="M1.75 8h12.5M8 1.75c1.8 1.9 2.6 4 2.6 6.25S9.8 12.35 8 14.25C6.2 12.35 5.4 10.25 5.4 8S6.2 3.65 8 1.75Z" /></>,
  todo: <><path d="M7.25 4h6.5M7.25 8h6.5M7.25 12h6.5" /><path d="m2 4 1.1 1.1L5 3.1M2 11.5l1.1 1.1L5 10.6" /></>,
  agent: <><rect x="2.75" y="5" width="10.5" height="8.25" rx="2.5" /><path d="M8 5V2.5M6 9.25v.5M10 9.25v.5" /></>,
  chat: <path d="M13.25 9.5a1.75 1.75 0 0 1-1.75 1.75H6.25l-3.5 2.5V4.5A1.75 1.75 0 0 1 4.5 2.75h7a1.75 1.75 0 0 1 1.75 1.75v5Z" />,
  send: <path d="M14.25 1.75 7 9M14.25 1.75 9.75 14.25 7 9 1.75 6.25l12.5-4.5Z" />,
  bell: <><path d="M8 2a3.5 3.5 0 0 0-3.5 3.5c0 3-1.5 4-1.5 4h10s-1.5-1-1.5-4A3.5 3.5 0 0 0 8 2Z" /><path d="M6.8 13.5a1.3 1.3 0 0 0 2.4 0" /></>,
  clock: <><circle cx="8" cy="8" r="6.25" /><path d="M8 4.5V8l2.25 1.5" /></>,
  sparkle: <path d="M8 1.75c.4 3.1 1.65 4.35 4.75 4.75-3.1.4-4.35 1.65-4.75 4.75-.4-3.1-1.65-4.35-4.75-4.75C6.35 6.1 7.6 4.85 8 1.75ZM12.5 10.5c.2 1.3.7 1.8 2 2-1.3.2-1.8.7-2 2-.2-1.3-.7-1.8-2-2 1.3-.2 1.8-.7 2-2Z" />,
  stack: <><path d="m8 1.75 6.25 3.25L8 8.25 1.75 5 8 1.75Z" /><path d="m1.75 8 6.25 3.25L14.25 8M1.75 11 8 14.25 14.25 11" /></>,
  ban: <><circle cx="8" cy="8" r="6" /><path d="m3.75 3.75 8.5 8.5" /></>,
  spin: <path d="M8 1.75A6.25 6.25 0 1 1 1.75 8" />,
  tool: <path d="M9.9 2.1a3.5 3.5 0 0 0-4.3 4.6L2 10.3a1.2 1.2 0 0 0 0 1.7l2 2a1.2 1.2 0 0 0 1.7 0l3.6-3.6a3.5 3.5 0 0 0 4.6-4.3l-2 2-2-.4-.4-2 2-2Z" />,
};

export function ToolIcon({ name, className = "" }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name] ?? PATHS.tool}
    </svg>
  );
}
