// GitWatchReconciler — keeps the GitWatcher's watched dirs in lockstep with the
// live worker rows. The set changes rarely (spawn / exit / remove, and a fresh
// worktree's workspace_ready flip), so we react to the worker bus topics through
// a debounced schedule() — cheap under the worker:change firehose during a turn.
// Holding one handle per dir makes watch() idempotent across reconciles; the
// underlying GitWatcher ref-counts, so workers sharing a checkout share a watch.

import type { GitWatcher } from "../../core/src/ports/GitWatcher.ts";

const DEBOUNCE_MS = 750;

export interface GitWatchReconcilerDeps {
  watcher: GitWatcher;
  // The set of working dirs that should currently be watched (deduped here).
  desiredDirs: () => string[];
}

export class GitWatchReconciler {
  private handles = new Map<string, () => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private watcher: GitWatcher;
  private desiredDirs: () => string[];

  constructor(deps: GitWatchReconcilerDeps) {
    this.watcher = deps.watcher;
    this.desiredDirs = deps.desiredDirs;
  }

  schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.reconcile();
    }, DEBOUNCE_MS);
    this.timer.unref?.();
  }

  reconcile(): void {
    const desired = new Set(this.desiredDirs());
    for (const dir of desired) {
      if (!this.handles.has(dir)) this.handles.set(dir, this.watcher.watch(dir));
    }
    for (const [dir, unsub] of this.handles) {
      if (!desired.has(dir)) {
        unsub();
        this.handles.delete(dir);
      }
    }
  }
}
