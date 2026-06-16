// GitWatcher port — ref-counted watching of a working tree's git state for live
// UI refresh. The adapter (ChokidarGitWatcher) observes a repo's .git internals
// (HEAD, index, refs, merge/rebase state) and its working-tree files, classifies
// each change into a GitChangeKind, and pushes ONE coalesced event per affected
// dir through the injected sink. Like FileWatcher it never imports the EventBus
// (Dependency Inversion — the manager supplies a sink that publishes
// "git:change"). Watching is ref-counted so N workers sharing a checkout — and
// linked worktrees sharing the common .git — keep one underlying set of watches.

import type { GitChangeEvent, GitChangeKind } from "../../../contracts/src/events.ts";

export type { GitChangeEvent, GitChangeKind };

// The adapter calls this with one coalesced event for a single working dir; the
// manager fans it out to the bus → SSE → web. Never called with empty `kinds`.
export type GitChangeSink = (event: GitChangeEvent) => void;

export interface GitWatcher {
  // Ref-counted: repeated watch(dir) on the same working dir share one underlying
  // set of OS watches. The returned unsubscribe decrements; watches close at 0
  // refs. `dir` is a working-tree path; the adapter resolves its git dirs itself
  // and emits events keyed by this same `dir` (the web keys its git state on it).
  watch(dir: string): () => void;
  // Drop every watch (daemon shutdown).
  closeAll(): Promise<void>;
}
