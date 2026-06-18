// MemoryProvider — narrow port over the configured memory sources (CLAUDE.md and
// any AGENTS.md-style files declared under config.memory.sources): each source's
// user-level paths plus its filename chain walked from the worker's cwd up to the
// repo root. Backends that isolate themselves from filesystem settings — the
// claude-sdk lane runs settingSources:[] — use it to supply the memory they would
// otherwise lose. Which sources to read is injected config; discovery + I/O live
// in the infra adapter. Synchronous, mirroring the DPI assembly it feeds.

export interface MemoryScope {
  readonly cwd: string;
  // Upper bound for the project walk-up (the worktree's source repo when spawned in
  // a worktree). Null → the adapter finds the boundary (nearest .git, else fs root).
  readonly repoRoot?: string | null;
}

export interface MemoryDoc {
  readonly sourceId: string;              // config source key, e.g. "claude"
  readonly sourceLabel: string;           // section heading, e.g. "CLAUDE.md"
  // Backend kinds that load this source themselves (source.assumeNativeFor) →
  // selectInjectableMemory drops the doc for them so memory is never doubled.
  readonly nativeFor: readonly string[];
  readonly path: string;
  readonly level: "user" | "project";
  readonly content: string;
}

export interface MemorySnapshot {
  // Grouped by source (sources in priority order); within a source, user docs
  // first, then project docs ordered root → cwd (general → specific).
  readonly docs: readonly MemoryDoc[];
}

export interface MemoryProvider {
  load(scope: MemoryScope): MemorySnapshot;
}
