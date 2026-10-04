// The user's memories (~/.eos/profile/memories/<id>.md). Synchronous like
// PageStore: the daemon is the only writer and prompt assembly reads them at spawn.

import type { UserMemory } from "../../../contracts/src/profile.ts";

export interface UserMemoryStore {
  list(): UserMemory[];
  get(id: string): UserMemory | null;
  put(memory: UserMemory): void;
  // Soft delete (recoverable by hand); false when there was nothing to remove.
  remove(id: string): boolean;
}
