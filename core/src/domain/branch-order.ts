// orderBranches — branch-picker ordering policy (pure, no IO). Ranks branches by
// the usage signal: most-recently-used first (the signal is newest-first), with
// branches absent from it falling to a stable alphabetical tail. The current
// branch, when the signal hasn't seen it (e.g. a fresh worktree with an empty
// reflog), is treated as most-recent so it never sinks into the tail. Knows
// nothing about WHERE usage comes from (reflog today) — it just consumes a list.

export function orderBranches(
  branches: string[],
  usage: string[],
  current: string | null,
): string[] {
  const rank = new Map<string, number>();
  usage.forEach((name, i) => { if (!rank.has(name)) rank.set(name, i); });
  if (current && !rank.has(current)) rank.set(current, -1);

  const rankOf = (name: string): number => rank.get(name) ?? Infinity;
  return [...branches].sort((a, b) => {
    const ra = rankOf(a), rb = rankOf(b);
    if (ra !== rb) return ra < rb ? -1 : 1;
    return a.localeCompare(b);
  });
}
