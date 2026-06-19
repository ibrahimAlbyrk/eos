// Pure spawn-isolation policy — zero I/O, fully unit-testable. When the user
// disables worktrees (settings: git.spawnWithoutWorktree), a worktree spawn
// is downgraded to a plain-cwd spawn in the source checkout. A worker definition may
// also declare a default isolation (worktree | cwd) that takes effect when the
// request didn't already imply one: "cwd" downgrades a worktree spawn, while
// "worktree" promotes a plain-cwd spawn into an isolated tree. The global
// worktrees-disabled setting always wins over a definition's "worktree" preference.
// Explicit workspaceOf attaches are never re-decided — attaching to an existing
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
  opts: { worktreesDisabled: boolean; definitionIsolation?: "worktree" | "cwd" },
): SpawnIsolation {
  // An explicit attach is never re-decided.
  if (spec.workspaceOf) return { cwd: spec.cwd, worktreeFrom: spec.worktreeFrom };
  // Downgrade a worktree spawn to plain-cwd when worktrees are disabled globally
  // or the definition asks for cwd isolation.
  if ((opts.worktreesDisabled || opts.definitionIsolation === "cwd") && spec.worktreeFrom) {
    return { cwd: spec.worktreeFrom, worktreeFrom: undefined };
  }
  // A definition that wants a worktree promotes a plain-cwd spawn into an isolated
  // tree — but never when the user disabled worktrees globally (that wins).
  if (!opts.worktreesDisabled && opts.definitionIsolation === "worktree" && spec.cwd && !spec.worktreeFrom) {
    return { cwd: undefined, worktreeFrom: spec.cwd };
  }
  return { cwd: spec.cwd, worktreeFrom: spec.worktreeFrom };
}
