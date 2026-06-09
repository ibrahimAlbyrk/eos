// gitMode and termMode are mutually exclusive — terminal mode owns the
// composer while active, so entering git mode is a no-op until it's off.
// (The `!` terminal entry in Composer.jsx has the mirror guard.)
export function nextGitMode({ gitMode, termMode }, on) {
  const next = on ?? !gitMode;
  if (next && termMode) return gitMode;
  return next;
}
