// Dock-width configuration (fractions of the owning pane's width) — the single
// source of truth for how wide docked right-panel viewers open. A panel type may
// override the shared default via its registry descriptor's `defaultFrac`.

// Shared default width for docked panels.
export const DOCK_DEFAULT_FRAC = 0.5;

// Files panel opens 40% narrower than the shared default (0.5 × 0.6 = 0.3).
export const FILES_PANEL_WIDTH_FRAC = DOCK_DEFAULT_FRAC * 0.6;

// "Files in Chat" is a compact list (like Files), so it opens at the same
// narrower default rather than the shared half-width.
export const CHAT_FILES_PANEL_WIDTH_FRAC = DOCK_DEFAULT_FRAC * 0.6;
