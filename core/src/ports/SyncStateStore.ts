// SyncStateStore — this Mac's sync bookkeeping (~/.eos/sync/). The index remembers,
// per record, the vault seq it last matched and the hash of the local record at that
// moment: a different hash later means a local change to push; the records
// themselves carry no sync fields.

export interface SyncIndexEntry {
  readonly seq: number;
  // null = the record is deleted (a tombstone in the vault).
  readonly hash: string | null;
}

export interface SyncLocalState {
  readonly cursor: number;
  // Keyed "<domain>/<id>".
  readonly index: Readonly<Record<string, SyncIndexEntry>>;
}

export interface SyncStateStore {
  load(): SyncLocalState;
  save(state: SyncLocalState): void;
  // The losing side of a conflict — kept, never dropped.
  saveConflict(domain: string, id: string, data: unknown): void;
}
