// NodeFileWatcher — chokidar implementation of the FileWatcher port. Each
// watched directory is shallow (depth 0, no recursion → no inotify storm on
// large trees) and ref-counted (N subscribers share one OS watch). Change
// events are coalesced into debounced batches and pushed through the injected
// sink (which the manager wires to bus.publish("fs:change", …)). followSymlinks
// is off so symlink loops can never hang the watcher.

import chokidar, { type FSWatcher } from "chokidar";
import { dirname } from "node:path";
import type { Clock } from "../../../core/src/ports/Clock.ts";
import { IGNORED_ENTRIES } from "../../../core/src/domain/fsIgnore.ts";
import type { FileWatcher, FsChangeEvent, FsChangeKind, FsChangeSink } from "../../../core/src/ports/FileWatcher.ts";

const DEBOUNCE_MS = 120;

export interface NodeFileWatcherDeps {
  clock: Clock;
  sink: FsChangeSink;
}

export class NodeFileWatcher implements FileWatcher {
  private watches = new Map<string, { watcher: FSWatcher; refs: number }>();
  private buffer = new Map<string, FsChangeEvent>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private clock: Clock;
  private sink: FsChangeSink;

  constructor(deps: NodeFileWatcherDeps) {
    this.clock = deps.clock;
    this.sink = deps.sink;
  }

  watch(dir: string): () => void {
    const existing = this.watches.get(dir);
    if (existing) {
      existing.refs++;
      return () => this.release(dir);
    }
    const watcher = chokidar.watch(dir, {
      depth: 0,
      ignoreInitial: true,
      followSymlinks: false,
      ignored: (p: string) => IGNORED_ENTRIES.has(p.slice(p.lastIndexOf("/") + 1)),
    });
    const handler = (kind: FsChangeKind) => (path: string) => this.enqueue(kind, path);
    watcher
      .on("add", handler("add"))
      .on("change", handler("change"))
      .on("unlink", handler("unlink"))
      .on("addDir", handler("addDir"))
      .on("unlinkDir", handler("unlinkDir"));
    this.watches.set(dir, { watcher, refs: 1 });
    return () => this.release(dir);
  }

  async closeAll(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.buffer.clear();
    const all = [...this.watches.values()];
    this.watches.clear();
    await Promise.all(all.map((w) => w.watcher.close().catch(() => {})));
  }

  private release(dir: string): void {
    const w = this.watches.get(dir);
    if (!w) return;
    w.refs--;
    if (w.refs <= 0) {
      this.watches.delete(dir);
      w.watcher.close().catch(() => {});
    }
  }

  private enqueue(kind: FsChangeKind, path: string): void {
    this.buffer.set(`${kind}\0${path}`, { kind, path, dir: dirname(path), ts: this.clock.now() });
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), DEBOUNCE_MS);
      this.flushTimer.unref?.();
    }
  }

  private flush(): void {
    this.flushTimer = null;
    if (this.buffer.size === 0) return;
    const batch = [...this.buffer.values()];
    this.buffer.clear();
    this.sink(batch);
  }
}
