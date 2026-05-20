// SVG icon library — 1.5px stroke, currentColor. Sized at 16 by default.
// Sans-serif modern dev tool look (Linear/Vercel/Resend).

export const Icon = ({ name, size = 16, strokeWidth = 1.5, ...rest }) => {
  const paths = ICONS[name];
  if (!paths) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {paths}
    </svg>
  );
};

export const ICONS = {
  // Status / state
  play: <polygon points="6 4 20 12 6 20 6 4" />,
  pause: <><rect x="6" y="5" width="4" height="14" /><rect x="14" y="5" width="4" height="14" /></>,
  stop: <rect x="6" y="6" width="12" height="12" rx="1" />,
  check: <polyline points="5 12 10 17 19 7" />,
  cross: <><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></>,
  alert: <><path d="M12 3 2 21h20L12 3z" /><line x1="12" y1="10" x2="12" y2="14" /><circle cx="12" cy="17.5" r="0.6" fill="currentColor" /></>,
  spinner: <path d="M21 12a9 9 0 1 1-6.219-8.56" />,

  // Agent tree
  agent: <><circle cx="12" cy="9" r="3.5" /><path d="M5 20c1.5-3.5 4-5 7-5s5.5 1.5 7 5" /></>,
  orchestrator: <><circle cx="12" cy="12" r="3" /><circle cx="12" cy="12" r="8" strokeDasharray="2 3" /></>,
  branch: <><circle cx="6" cy="6" r="2" /><circle cx="6" cy="18" r="2" /><circle cx="18" cy="12" r="2" /><path d="M6 8v8M8 12h7" /></>,
  worktree: <><rect x="3" y="4" width="6" height="6" rx="1" /><rect x="15" y="4" width="6" height="6" rx="1" /><rect x="9" y="14" width="6" height="6" rx="1" /><path d="M6 10v2h12v-2M12 14v-2" /></>,

  // Tools
  tool: <path d="M14.7 6.3a4 4 0 0 0-5.2 5.2L3 18l3 3 6.5-6.5a4 4 0 0 0 5.2-5.2L15 12l-3-3 2.7-2.7z" />,
  hammer: <path d="M14 7 7 14l-3-3 7-7 3 3z M14 7l5-5 3 3-5 5 M14 7l3 3" />,
  read: <><rect x="4" y="4" width="16" height="16" rx="1" /><line x1="8" y1="9" x2="16" y2="9" /><line x1="8" y1="13" x2="16" y2="13" /><line x1="8" y1="17" x2="12" y2="17" /></>,
  edit: <><path d="M4 20h4l10-10-4-4L4 16v4z" /><path d="M14 6l4 4" /></>,
  terminal: <><polyline points="5 8 9 12 5 16" /><line x1="13" y1="16" x2="19" y2="16" /></>,
  grep: <><circle cx="11" cy="11" r="6" /><line x1="20" y1="20" x2="15.5" y2="15.5" /></>,
  globe: <><circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="4" ry="9" /><line x1="3" y1="12" x2="21" y2="12" /></>,
  spawn: <><circle cx="12" cy="12" r="9" /><line x1="12" y1="8" x2="12" y2="16" /><line x1="8" y1="12" x2="16" y2="12" /></>,

  // UI controls
  plus: <><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></>,
  send: <path d="M22 2 11 13 M22 2l-7 20-4-9-9-4 20-7z" />,
  chevronRight: <polyline points="9 6 15 12 9 18" />,
  chevronDown: <polyline points="6 9 12 15 18 9" />,
  chevronLeft: <polyline points="15 6 9 12 15 18" />,
  copy: <><rect x="9" y="9" width="11" height="11" rx="1.5" /><path d="M5 15V5a1 1 0 0 1 1-1h10" /></>,
  search: <><circle cx="11" cy="11" r="6" /><line x1="20" y1="20" x2="15.5" y2="15.5" /></>,
  command: <path d="M6 9a3 3 0 1 1 3-3v12a3 3 0 1 1-3-3h12a3 3 0 1 1-3 3V6a3 3 0 1 1 3 3z" />,
  panelLeft: <><rect x="3" y="4" width="18" height="16" rx="1.5" /><line x1="9" y1="4" x2="9" y2="20" /></>,
  panelRight: <><rect x="3" y="4" width="18" height="16" rx="1.5" /><line x1="15" y1="4" x2="15" y2="20" /></>,
  more: <><circle cx="6" cy="12" r="1" fill="currentColor" /><circle cx="12" cy="12" r="1" fill="currentColor" /><circle cx="18" cy="12" r="1" fill="currentColor" /></>,
  refresh: <><path d="M21 12a9 9 0 1 1-3-6.7" /><polyline points="21 4 21 9 16 9" /></>,
  trash: <><polyline points="4 7 20 7" /><path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3" /><path d="M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" /></>,
  arrowRight: <><line x1="5" y1="12" x2="19" y2="12" /><polyline points="13 6 19 12 13 18" /></>,
  sparkle: <path d="M12 3l1.5 5L19 9.5 13.5 11 12 16l-1.5-5L5 9.5 10.5 8z M19 16l.7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7z" />,
  clock: <><circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 16 14" /></>,
  zap: <polygon points="13 2 4 14 12 14 11 22 20 10 12 10 13 2" />,
  dotsThree: <><circle cx="12" cy="12" r="1" fill="currentColor" /><circle cx="6" cy="12" r="1" fill="currentColor" /><circle cx="18" cy="12" r="1" fill="currentColor" /></>,
  shield: <path d="M12 3 4 6v6c0 4.5 3.5 8 8 9 4.5-1 8-4.5 8-9V6l-8-3z" />,
  user: <><circle cx="12" cy="9" r="3.5" /><path d="M5 20c1.5-3.5 4-5 7-5s5.5 1.5 7 5" /></>,
  cpu: <><rect x="5" y="5" width="14" height="14" rx="1.5" /><rect x="9" y="9" width="6" height="6" /><line x1="3" y1="9" x2="5" y2="9" /><line x1="3" y1="15" x2="5" y2="15" /><line x1="19" y1="9" x2="21" y2="9" /><line x1="19" y1="15" x2="21" y2="15" /><line x1="9" y1="3" x2="9" y2="5" /><line x1="15" y1="3" x2="15" y2="5" /><line x1="9" y1="19" x2="9" y2="21" /><line x1="15" y1="19" x2="15" y2="21" /></>,
  coins: <><ellipse cx="12" cy="7" rx="8" ry="3" /><path d="M4 7v5c0 1.7 3.6 3 8 3s8-1.3 8-3V7" /><path d="M4 12v5c0 1.7 3.6 3 8 3s8-1.3 8-3v-5" /></>,
  link: <><path d="M10 14a4 4 0 0 1 0-5.7l3-3a4 4 0 0 1 5.7 5.7l-1.5 1.5" /><path d="M14 10a4 4 0 0 1 0 5.7l-3 3a4 4 0 0 1-5.7-5.7L6.8 12" /></>,
  folder: <path d="M3 6a1 1 0 0 1 1-1h5l2 2h8a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6z" />,
  history: <><path d="M3 12a9 9 0 1 0 3-6.7" /><polyline points="3 4 3 9 8 9" /><polyline points="12 7 12 12 16 14" /></>,
  filter: <polygon points="3 4 21 4 14 13 14 20 10 18 10 13 3 4" />,
  list: <><line x1="8" y1="6" x2="20" y2="6" /><line x1="8" y1="12" x2="20" y2="12" /><line x1="8" y1="18" x2="20" y2="18" /><circle cx="4" cy="6" r="1" fill="currentColor" /><circle cx="4" cy="12" r="1" fill="currentColor" /><circle cx="4" cy="18" r="1" fill="currentColor" /></>,
  kill: <><circle cx="12" cy="12" r="9" /><line x1="8" y1="8" x2="16" y2="16" /><line x1="16" y1="8" x2="8" y2="16" /></>,
  flame: <path d="M12 3s4 4 4 8a4 4 0 1 1-8 0c0-2 1-3 1-3s-1 4 1.5 4S12 9 12 9s-2-2-2-4 2-2 2-2z" />,
  thinking: <><circle cx="12" cy="12" r="9" /><circle cx="9" cy="11" r="0.8" fill="currentColor" /><circle cx="12" cy="11" r="0.8" fill="currentColor" /><circle cx="15" cy="11" r="0.8" fill="currentColor" /></>,
  pin: <path d="M12 2v8M8 10h8l-2 6h-4l-2-6M12 16v6" />,
};

// Kept on window so any legacy code path that still reads window.Icon works.
// Phase C migrates callers to ES module imports; this can be removed once all
// components consume `import { Icon } from './icons.jsx'`.
window.Icon = Icon;
