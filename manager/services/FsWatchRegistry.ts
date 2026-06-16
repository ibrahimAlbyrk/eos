// Tracks which directories each SSE client (browser tab) is watching, so a
// dropped connection tears down all of that client's chokidar watches even if
// the explicit DELETE /fs/unwatch never arrives (tab crash, reload, network
// drop). The underlying FileWatcher ref-counts across clients — two tabs
// watching the same dir keep it alive until both disconnect.

import type { FileWatcher } from "../../core/src/ports/FileWatcher.ts";

export class FsWatchRegistry {
  private byClient = new Map<string, Map<string, () => void>>();
  private watcher: FileWatcher;

  constructor(deps: { watcher: FileWatcher }) {
    this.watcher = deps.watcher;
  }

  watch(clientId: string, dir: string): void {
    let dirs = this.byClient.get(clientId);
    if (!dirs) {
      dirs = new Map();
      this.byClient.set(clientId, dirs);
    }
    if (dirs.has(dir)) return; // this client already watches this dir
    dirs.set(dir, this.watcher.watch(dir));
  }

  unwatch(clientId: string, dir: string): void {
    const dirs = this.byClient.get(clientId);
    const unsub = dirs?.get(dir);
    if (!unsub) return;
    unsub();
    dirs!.delete(dir);
    if (dirs!.size === 0) this.byClient.delete(clientId);
  }

  // SSE connection closed — release every watch this client held.
  dropClient(clientId: string): void {
    const dirs = this.byClient.get(clientId);
    if (!dirs) return;
    for (const unsub of dirs.values()) unsub();
    this.byClient.delete(clientId);
  }
}
