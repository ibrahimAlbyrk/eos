// FileWatcher port — ref-counted directory watching for the Files explorer.
// The adapter (NodeFileWatcher, chokidar) pushes coalesced change batches
// through an injected FsChangeSink; it never imports the EventBus or SSE
// (Dependency Inversion — the manager supplies a sink that publishes
// "fs:change"). Watching is shallow (one level per dir) and ref-counted so N
// subscribers on the same dir share one OS watch.

export type FsChangeKind = "add" | "change" | "unlink" | "addDir" | "unlinkDir";

export interface FsChangeEvent {
  kind: FsChangeKind;
  path: string; // absolute path of the changed entry
  dir: string; // absolute path of its parent (the watched dir)
  ts: number;
}

// The adapter calls this with a coalesced batch; the manager fans it out to the
// bus → SSE → web. Never called with an empty array.
export type FsChangeSink = (changes: FsChangeEvent[]) => void;

export interface FileWatcher {
  // Ref-counted: repeated watch(dir) on the same dir share one underlying
  // watch. The returned unsubscribe decrements; the watch closes at 0 refs.
  watch(dir: string): () => void;
  // Drop every watch (daemon shutdown).
  closeAll(): Promise<void>;
}
