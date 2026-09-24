// Ghostty-style macOS line editing. xterm.js sends nothing for ⌘+arrow and
// CSI 1;3D for ⌥+arrow, which neither shells nor Claude Code read as line/word
// motion — so map them to the readline bytes Ghostty sends by default.
const CMD_KEYS = { ArrowLeft: "\x01", ArrowRight: "\x05", Backspace: "\x15" }; // ^A ^E ^U
const OPT_KEYS = { ArrowLeft: "\x1bb", ArrowRight: "\x1bf" }; // ESC b / ESC f

export function macEditBytes(e) {
  if (e.ctrlKey || e.shiftKey || e.metaKey === e.altKey) return null;
  return (e.metaKey ? CMD_KEYS : OPT_KEYS)[e.key] ?? null;
}

// Backslash-escape a dropped path the way Ghostty does, so a path with spaces or
// shell metacharacters pastes as one argument.
export function shellEscapePath(p) {
  return p.replace(/[\s\\()[\]{}<>"'`!#$&;|*?]/g, "\\$&");
}
