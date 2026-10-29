export interface PoolItem {
  key: string;
  // Showing somewhere (a peek or a tab) — never closed by the pool.
  placed: boolean;
  lastUsed: number;
}

/** The views to close: unplaced ones idle for `idleMs`, then the least recently used unplaced ones over `cap`. */
export function pickEvictions(items: PoolItem[], cap: number, now: number, idleMs: number): string[] {
  const out = new Set<string>();
  for (const it of items) if (!it.placed && now - it.lastUsed >= idleMs) out.add(it.key);
  const kept = items.filter((it) => !out.has(it.key));
  const over = kept.length - cap;
  if (over > 0) {
    kept
      .filter((it) => !it.placed)
      .sort((a, b) => a.lastUsed - b.lastUsed)
      .slice(0, over)
      .forEach((it) => out.add(it.key));
  }
  return [...out];
}
