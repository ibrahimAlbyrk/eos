// Resolve the id-keyed, partial config.memory.sources map into an ordered list of
// fully-defaulted sources: drop disabled entries, fold the key in as `id`, apply
// per-field defaults, and sort by priority then id (stable, deterministic order
// in the composed prompt). Pure — the infra provider consumes the result.

import type { MemorySource, MemorySourceSpec } from "../../../contracts/src/memory.ts";

export function resolveMemorySources(sources: Record<string, MemorySourceSpec>): MemorySource[] {
  return Object.entries(sources)
    .filter(([, s]) => s.enabled ?? true)
    .map(([id, s]) => ({
      id,
      label: s.label ?? id,
      userPaths: s.userPaths ?? [],
      projectFilenames: s.projectFilenames ?? [],
      priority: s.priority ?? 0,
      assumeNativeFor: s.assumeNativeFor ?? [],
    }))
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}
