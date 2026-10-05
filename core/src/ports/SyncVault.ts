// SyncVault — the relay's encrypted record store for one sync key
// (relay/vault/). Records are opaque blobs under opaque keys; every write gets the
// vault's next sequence number, and a write must name the seq it replaces
// (compare-and-swap), so two Macs can never silently overwrite each other.

export interface SyncVaultEntry {
  readonly key: string;
  readonly seq: number;
  readonly data: Uint8Array;
}

export interface SyncVaultChanges {
  readonly head: number;
  readonly entries: readonly SyncVaultEntry[];
  readonly more: boolean;
}

// conflict = the record moved on since baseSeq; `entry` is what it holds now.
export type SyncPutResult =
  | { readonly ok: true; readonly seq: number }
  | { readonly ok: false; readonly entry: SyncVaultEntry };

export interface SyncVault {
  // Entries written after `since`. With waitMs > 0 and nothing new, the vault holds
  // the request until a write lands or the wait runs out.
  changes(since: number, waitMs: number, signal?: AbortSignal): Promise<SyncVaultChanges>;
  put(key: string, baseSeq: number, data: Uint8Array): Promise<SyncPutResult>;
}
