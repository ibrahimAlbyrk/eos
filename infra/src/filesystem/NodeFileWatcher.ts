// NodeFileWatcher — native fs.watch implementation of the FileWatcher port. Each
// watched directory is shallow (direct entries only → no storm on large trees)
// and ref-counted (N subscribers share one OS watch). A native dir watch costs no
// fd (FSEvents/inotify); chokidar v4 held a kqueue fd per FILE on macOS, which
// pushed the daemon past fd 10240 — where posix_spawn fails every child EBADF.
// The OS event type is unreliable (macOS reports an edit as a rename), so each
// debounced batch lstats the touched names and diffs them against the dir's
// known entries to derive the kind, then pushes the batch through the injected
// sink (which the manager wires to bus.publish("fs:change", …)). lstat, not
// stat, so symlinks are never followed.

import { watch as fsWatch, readdirSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { Clock } from "../../../core/src/ports/Clock.ts";
import { IGNORED_ENTRIES } from "../../../core/src/domain/fsIgnore.ts";
import type { FileWatcher, FsChangeEvent, FsChangeKind, FsChangeSink } from "../../../core/src/ports/FileWatcher.ts";

const DEBOUNCE_MS = 120;

export interface NodeFileWatcherDeps {
  clock: Clock;
  sink: FsChangeSink;
}

interface DirWatch {
  refs: number;
  close: () => void;
  entries: Map<string, boolean>; // name → isDir, as of the last flush
  touched: Set<string>; // names the OS reported since the last flush
}

function listEntries(dir: string): Map<string, boolean> {
  try {
    const entries = readdirSync(dir, { withFileTypes: true }).filter((e) => !IGNORED_ENTRIES.has(e.name));
    return new Map(entries.map((e) => [e.name, e.isDirectory()]));
  } catch {
    return new Map();
  }
}

// isDir null = the entry is gone now.
function diffEntry(entries: Map<string, boolean>, name: string, isDir: boolean | null): FsChangeKind | null {
  const wasDir = entries.get(name);
  if (isDir === null) {
    if (wasDir === undefined) return null; // came and went within one batch (an editor's temp file)
    entries.delete(name);
    return wasDir ? "unlinkDir" : "unlink";
  }
  entries.set(name, isDir);
  if (wasDir !== isDir) return isDir ? "addDir" : "add";
  return isDir ? null : "change"; // a dir's own metadata churn isn't an entry change
}

export class NodeFileWatcher implements FileWatcher {
  private watches = new Map<string, DirWatch>();
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
    const w: DirWatch = { refs: 1, close: () => {}, entries: listEntries(dir), touched: new Set() };
    try {
      const watcher = fsWatch(dir, (_event, name) => {
        if (!name || IGNORED_ENTRIES.has(name)) return;
        w.touched.add(name);
        this.scheduleFlush();
      });
      watcher.on("error", () => watcher.close());
      w.close = () => watcher.close();
    } catch {
      // The dir vanished before the watch started — nothing to report.
    }
    this.watches.set(dir, w);
    return () => this.release(dir);
  }

  async closeAll(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const all = [...this.watches.values()];
    this.watches.clear();
    for (const w of all) w.close();
  }

  private release(dir: string): void {
    const w = this.watches.get(dir);
    if (!w) return;
    w.refs--;
    if (w.refs <= 0) {
      this.watches.delete(dir);
      w.close();
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => void this.flush(), DEBOUNCE_MS);
    this.flushTimer.unref?.();
  }

  private async flush(): Promise<void> {
    this.flushTimer = null;
    const ts = this.clock.now();
    const batch: FsChangeEvent[] = [];
    for (const [dir, w] of this.watches) {
      const names = [...w.touched];
      w.touched.clear();
      for (const name of names) {
        const path = join(dir, name);
        const isDir = await lstat(path).then((st) => st.isDirectory(), () => null);
        const kind = diffEntry(w.entries, name, isDir);
        if (kind) batch.push({ kind, path, dir, ts });
      }
    }
    if (batch.length > 0) this.sink(batch);
  }
}
