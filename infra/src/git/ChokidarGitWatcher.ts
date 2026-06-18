// ChokidarGitWatcher — observes a working tree's git state for live UI refresh
// (the GitWatcher port). For each watched working dir it resolves the git dirs
// and sets up chokidar watches over:
//   * the per-worktree git dir (depth 0)        → HEAD / index / merge|rebase state
//   * the shared common dir (depth 0)           → packed-refs (linked worktrees)
//   * <commonDir>/refs (recursive)              → branch / tag / remote / stash refs
//   * the working tree (recursive, .git + deps + .eos ignored) → uncommitted edits
// Each filesystem path maps to one GitChangeKind; changes are debounced and
// coalesced per working dir, then pushed through the sink as a single event.
//
// We deliberately do NOT watch <commonDir> recursively — objects/ churns on
// every commit/gc/fetch and would storm. refs/ + the loose meta files above
// already cover every branch/commit/stash transition.
//
// Sharing: linked worktrees of one repo share the common .git, so a commit in
// worktree A fires the shared refs watch — every working dir that registered
// that target is notified, each with an event keyed by its OWN dir. Targets are
// ref-counted across working dirs so one shared .git keeps a single OS watch.

import chokidar, { type FSWatcher } from "chokidar";
import type { Clock } from "../../../core/src/ports/Clock.ts";
import type { GitDirs } from "../../../core/src/ports/GitInfo.ts";
import type { GitChangeKind, GitChangeSink, GitWatcher } from "../../../core/src/ports/GitWatcher.ts";
import { IGNORED_ENTRIES } from "../../../core/src/domain/fsIgnore.ts";

const DEBOUNCE_MS = 200;

// One git operation touches many paths (a commit rewrites index, a ref, and a
// reflog) — coalesce them into one event per dir after this quiet window.

export interface ChokidarGitWatcherDeps {
  clock: Clock;
  sink: GitChangeSink;
  resolveDirs: (cwd: string) => Promise<GitDirs | null>;
}

type Classifier = (path: string) => GitChangeKind | null;

interface RepoWatch {
  refs: number;
  targets: string[]; // chokidar target paths this working dir registered
}

interface TargetWatch {
  watcher: FSWatcher;
  classify: Classifier;
  consumers: Set<string>; // working dirs to notify when this target fires
}

function baseName(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

// Loose meta files at a git dir's top level. COMMIT_EDITMSG / config / the logs
// dir are intentionally unmatched — they don't change repo state the UI shows.
function classifyGitDir(p: string): GitChangeKind | null {
  const b = baseName(p);
  if (b === "HEAD" || b === "ORIG_HEAD") return "head";
  if (b === "index") return "index";
  if (b === "packed-refs") return "refs";
  if (b === "MERGE_HEAD" || b === "CHERRY_PICK_HEAD" || b === "REVERT_HEAD" || b === "rebase-merge" || b === "rebase-apply") {
    return "conflict";
  }
  return null;
}

function classifyCommonTop(p: string): GitChangeKind | null {
  return baseName(p) === "packed-refs" ? "refs" : null;
}

function classifyRefs(p: string): GitChangeKind | null {
  // refs/stash is the stash ref; everything else under refs/ is a branch/tag/remote.
  return p.endsWith("/refs/stash") ? "stash" : "refs";
}

// Ignore VCS internals, dependency caches, build output (shared list) AND a
// nested .eos/ (a child worktree's churn must not re-fetch the parent — .eos is
// gitignored and filtered from status anyway). Scoped to paths BELOW root: an
// eos worktree's own root contains a ".eos" segment, so a bare segment test
// would match the watch root and chokidar v4 would suppress the whole watch.
function makeWorktreeIgnore(root: string): (p: string) => boolean {
  return (p) => {
    if (p === root) return false;
    const rel = p.startsWith(root + "/") ? p.slice(root.length + 1) : p;
    return rel.split("/").some((seg) => seg === ".eos" || IGNORED_ENTRIES.has(seg));
  };
}

const META_OPTS = { depth: 0, ignoreInitial: true, followSymlinks: false } as const;
const REFS_OPTS = { ignoreInitial: true, followSymlinks: false } as const;

export class ChokidarGitWatcher implements GitWatcher {
  private repos = new Map<string, RepoWatch>();
  private targets = new Map<string, TargetWatch>();
  private pending = new Map<string, Set<GitChangeKind>>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private clock: Clock;
  private sink: GitChangeSink;
  private resolveDirs: (cwd: string) => Promise<GitDirs | null>;

  constructor(deps: ChokidarGitWatcherDeps) {
    this.clock = deps.clock;
    this.sink = deps.sink;
    this.resolveDirs = deps.resolveDirs;
  }

  watch(dir: string): () => void {
    const existing = this.repos.get(dir);
    if (existing) {
      existing.refs++;
      return () => this.release(dir);
    }
    const entry: RepoWatch = { refs: 1, targets: [] };
    this.repos.set(dir, entry);
    // Resolution shells out to git, so it's async — set up the watches once it
    // returns, unless the dir was released (or the watcher closed) meanwhile.
    void this.setup(dir, entry);
    return () => this.release(dir);
  }

  async closeAll(): Promise<void> {
    this.closed = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.pending.clear();
    this.repos.clear();
    const all = [...this.targets.values()];
    this.targets.clear();
    await Promise.all(all.map((t) => t.watcher.close().catch(() => {})));
  }

  private async setup(dir: string, entry: RepoWatch): Promise<void> {
    let dirs: GitDirs | null = null;
    try {
      dirs = await this.resolveDirs(dir);
    } catch {
      // resolveDirs already collapses errors to null; dirs stays null here.
    }
    if (this.closed || entry.refs <= 0 || !dirs) return; // released while resolving, or not a repo
    for (const t of this.computeTargets(dirs)) {
      this.addTarget(t.path, t.opts, t.classify, dir);
      entry.targets.push(t.path);
    }
  }

  private computeTargets(dirs: GitDirs): Array<{ path: string; opts: object; classify: Classifier }> {
    const targets: Array<{ path: string; opts: object; classify: Classifier }> = [
      { path: dirs.gitDir, opts: META_OPTS, classify: classifyGitDir },
      { path: `${dirs.commonDir}/refs`, opts: REFS_OPTS, classify: classifyRefs },
      { path: dirs.toplevel, opts: { ...REFS_OPTS, ignored: makeWorktreeIgnore(dirs.toplevel) }, classify: () => "worktree" },
    ];
    // Shared common dir is its own watch only when distinct (linked worktree) —
    // in a normal checkout it's the same path as gitDir (already watched).
    if (dirs.commonDir !== dirs.gitDir) {
      targets.push({ path: dirs.commonDir, opts: META_OPTS, classify: classifyCommonTop });
    }
    return targets;
  }

  private addTarget(path: string, opts: object, classify: Classifier, consumerDir: string): void {
    const existing = this.targets.get(path);
    if (existing) {
      existing.consumers.add(consumerDir);
      return;
    }
    const watcher = chokidar.watch(path, opts);
    const tw: TargetWatch = { watcher, classify, consumers: new Set([consumerDir]) };
    const onFire = (filePath: string): void => this.onFire(path, filePath);
    watcher
      .on("add", onFire)
      .on("change", onFire)
      .on("unlink", onFire)
      .on("addDir", onFire)
      .on("unlinkDir", onFire);
    this.targets.set(path, tw);
  }

  private onFire(targetPath: string, filePath: string): void {
    const tw = this.targets.get(targetPath);
    if (!tw) return;
    const kind = tw.classify(filePath);
    if (!kind) return;
    for (const dir of tw.consumers) {
      let kinds = this.pending.get(dir);
      if (!kinds) {
        kinds = new Set();
        this.pending.set(dir, kinds);
      }
      kinds.add(kind);
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), DEBOUNCE_MS);
      this.flushTimer.unref?.();
    }
  }

  private flush(): void {
    this.flushTimer = null;
    if (this.pending.size === 0) return;
    const batch = [...this.pending.entries()];
    this.pending.clear();
    for (const [dir, kinds] of batch) {
      if (kinds.size === 0) continue;
      this.sink({ dir, kinds: [...kinds], ts: this.clock.now() });
    }
  }

  private release(dir: string): void {
    const entry = this.repos.get(dir);
    if (!entry) return;
    entry.refs--;
    if (entry.refs > 0) return;
    this.repos.delete(dir);
    this.pending.delete(dir);
    for (const path of entry.targets) this.removeTarget(path, dir);
  }

  private removeTarget(path: string, consumerDir: string): void {
    const tw = this.targets.get(path);
    if (!tw) return;
    tw.consumers.delete(consumerDir);
    if (tw.consumers.size === 0) {
      this.targets.delete(path);
      tw.watcher.close().catch(() => {});
    }
  }
}
