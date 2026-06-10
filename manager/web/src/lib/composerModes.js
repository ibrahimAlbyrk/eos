// gitMode and termMode are mutually exclusive — terminal mode owns the
// composer while active, so entering git mode is a no-op until it's off.
// (The `!` terminal entry in Composer.jsx has the mirror guard.)
export function nextGitMode({ gitMode, termMode }, on) {
  const next = on ?? !gitMode;
  if (next && termMode) return gitMode;
  return next;
}

// Flag↔mode converters shared by history capture (send) and recall apply.
// modeFlags always yields an exclusive pair, so applying a recalled mode can
// never produce gitMode && termMode.
export function composerMode({ gitMode, termMode }) {
  return termMode ? "term" : gitMode ? "git" : "chat";
}

export function modeFlags(mode) {
  return { gitMode: mode === "git", termMode: mode === "term" };
}
