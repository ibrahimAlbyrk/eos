// SyncCrypto — everything the sync engine does with the sync key's secret. The
// relay never sees a record id (recordKey is a keyed hash) or its content (seal is
// authenticated encryption bound to the record key).

export interface SyncCrypto {
  recordKey(domain: string, id: string): string;
  seal(recordKey: string, plaintext: Uint8Array): Uint8Array;
  // Throws when the blob was not sealed under this key for this record.
  open(recordKey: string, sealed: Uint8Array): Uint8Array;
  // Content fingerprint for change detection (not secret).
  hash(text: string): string;
}
