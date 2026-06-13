// Path encoding for Claude's per-project data directory. Claude stores a
// project's transcripts AND its file-based memory under
// ~/.claude/projects/<encodeCwd(realpath(cwd))>/. The rule: replace every char
// not in [a-zA-Z0-9_-] with a single dash. Single source of truth — the spawner
// (transcript tail, subagent meta) and the memory feature both rely on this
// matching Claude's scheme exactly; two copies would drift into a silent
// wrong-directory bug. Callers MUST pass a realpath'd path (symlinks + case
// canonicalized) before encoding.
export function encodeCwd(p: string): string {
  return p.replace(/[^a-zA-Z0-9_-]/g, "-");
}
