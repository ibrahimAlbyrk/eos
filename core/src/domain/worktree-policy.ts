// Pure spawn-isolation policy — zero I/O, fully unit-testable. When the user
// disables worktrees (settings: git.spawnWithoutWorktree), a worktree spawn
// is downgraded to a plain-cwd spawn in the source checkout. Explicit
// workspaceOf attaches are never downgraded — attaching to an existing
// worktree is a deliberate request, not a fresh isolation decision.

export interface SpawnIsolationInput {
  cwd?: string;
  worktreeFrom?: string;
  workspaceOf?: string;
}

export interface SpawnIsolation {
  cwd?: string;
  worktreeFrom?: string;
}

export function resolveSpawnIsolation(
  spec: SpawnIsolationInput,
  opts: { worktreesDisabled: boolean },
): SpawnIsolation {
  if (opts.worktreesDisabled && spec.worktreeFrom && !spec.workspaceOf) {
    return { cwd: spec.worktreeFrom, worktreeFrom: undefined };
  }
  return { cwd: spec.cwd, worktreeFrom: spec.worktreeFrom };
}
