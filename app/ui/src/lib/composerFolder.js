// The folder the next spawn runs in: the composer's pick, else the most recent
// folder. null under "No folder" (the daemon makes the agent a private scratch
// folder, deleted with it) — and when there is no folder at all, which spawns
// the same way.
export function composerCwd(composer, recents) {
  if (composer.noFolder) return null;
  return composer.cwd ?? recents?.[0] ?? null;
}
