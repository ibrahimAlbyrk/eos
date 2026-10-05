// SyncDomain — one kind of user data the sync engine carries (profile fields,
// memories, pages, …). An adapter speaks the portable form: what it lists is what
// travels, and apply() takes the same shape back through the domain's own write
// path. Machine-specific bits (absolute project paths, chat links) are translated or
// left out by the adapter, never by the engine.

import type { SyncDomainName } from "../../../contracts/src/sync.ts";

export interface SyncItem {
  readonly id: string;
  readonly data: unknown;
  // When the record last changed here, if the domain knows; decides conflicts.
  readonly updatedAt?: number;
}

export interface SyncDomain {
  readonly name: SyncDomainName;
  list(): Promise<readonly SyncItem[]>;
  get(id: string): Promise<SyncItem | null>;
  // Throws on data it can't accept; the engine keeps it as a conflict instead.
  apply(id: string, data: unknown): Promise<void>;
  remove(id: string): Promise<void>;
}
