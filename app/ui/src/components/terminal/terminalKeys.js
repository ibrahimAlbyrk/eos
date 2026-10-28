import { hostOS, modifiers } from "../../lib/platform.js";

// Ghostty-style macOS line editing. xterm.js sends nothing for ⌘+arrow and
// CSI 1;3D for ⌥+arrow, which neither shells nor Claude Code read as line/word
// motion — so map them to the readline bytes Ghostty sends by default.
const CMD_KEYS = { ArrowLeft: "\x01", ArrowRight: "\x05", Backspace: "\x15" }; // ^A ^E ^U
const OPT_KEYS = { ArrowLeft: "\x1bb", ArrowRight: "\x1bf" }; // ESC b / ESC f

export function macEditBytes(e) {
  // Elsewhere the shell reads its own keys (Ctrl+arrow moves by word).
  if (hostOS() !== "mac") return null;
  const m = modifiers(e);
  if (m.ctrl || m.shift || m.mod === m.alt) return null;
  return (m.mod ? CMD_KEYS : OPT_KEYS)[e.key] ?? null;
}

// Backslash-escape a dropped path the way Ghostty does, so a path with spaces or
// shell metacharacters pastes as one argument.
export function shellEscapePath(p) {
  return p.replace(/[\s\\()[\]{}<>"'`!#$&;|*?]/g, "\\$&");
}
