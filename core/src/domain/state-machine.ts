// Worker state machine — pure data + pure predicate. The DB write + logging
// side effects live in adapter code; this module is the rule book so it can
// be unit-tested and reasoned about in isolation.

import type { WorkerState } from "../../../contracts/src/events.ts";
export type { WorkerState };

/**
 * Allowed forward transitions per state. Anything not listed is rejected
 * (daemon logs `state_reject` with the requested move). DONE is terminal —
 * once a worker is DONE the DB row stays put until DELETE.
 */
export const ALLOWED_TRANSITIONS: Record<WorkerState, ReadonlyArray<WorkerState>> = {
  SPAWNING: ["WORKING", "IDLE", "ENDING", "DONE", "KILLING"],
  WORKING:  ["IDLE", "ENDING", "DONE", "KILLING"],
  IDLE:     ["WORKING", "ENDING", "DONE", "KILLING"],
  ENDING:   ["DONE", "KILLING"],
  KILLING:  ["DONE"],
  DONE:     [],
};

/**
 * Returns true if a worker in `from` is permitted to move to `to`.
 * Self-transitions return true (caller is expected to short-circuit before
 * touching the DB so the no-op doesn't log a state event).
 */
export function canTransition(from: WorkerState, to: WorkerState): boolean {
  if (from === to) return true;
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}
