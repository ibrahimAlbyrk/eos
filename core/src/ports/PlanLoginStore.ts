// PlanLoginStore — persistence port for the plan sign-in registry (the
// non-secret index of a provider's sign-ins; credentials stay in each store).
// PlanLoginDirs owns those store dirs on disk.

import type { PlanLoginRegistry } from "../domain/plan-logins.ts";

export interface PlanLoginStore {
  load(): PlanLoginRegistry;
  save(reg: PlanLoginRegistry): void;
}

export interface PlanLoginDirs {
  // A fresh, empty store dir for a new sign-in of `provider`.
  create(provider: string, id: string): string;
  // Drops a fresh store whose sign-in never finished (it holds no credential).
  discard(storeDir: string): void;
  // Moves a signed-out store aside, recoverable by hand.
  trash(storeDir: string): void;
}
