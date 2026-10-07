// Transfers this Mac ran — a regenerable log (state.db). The bytes of an
// unfinished one live in the destination's staging folder, not here.

import type { TransferRecord } from "../../../contracts/src/transfer.ts";

export interface TransferRepo {
  save(t: TransferRecord): void;
  get(id: string): TransferRecord | null;
  // Newest first.
  list(limit: number): TransferRecord[];
  remove(ids: readonly string[]): void;
}
