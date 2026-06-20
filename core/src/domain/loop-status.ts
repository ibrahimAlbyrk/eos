// Loop status machine — pure data + pure predicate, mirroring the worker
// state-machine. "active" is the only state with outgoing moves; "passed",
// "exhausted" and "stopped" are terminal. The repo write + event side effects
// live in the use-case/adapter layer; this module is the rule book so the
// transition contract can be unit-tested in isolation.

import type { LoopStatus } from "../../../contracts/src/loop.ts";
export type { LoopStatus };

export const ALLOWED_LOOP_TRANSITIONS: Record<LoopStatus, ReadonlyArray<LoopStatus>> = {
  active: ["passed", "exhausted", "stopped"],
  passed: [],
  exhausted: [],
  stopped: [],
};

// Returns true if a loop in `from` is permitted to move to `to`. Self-transitions
// return true (caller is expected to short-circuit before touching the DB).
export function canLoopTransition(from: LoopStatus, to: LoopStatus): boolean {
  if (from === to) return true;
  return ALLOWED_LOOP_TRANSITIONS[from]?.includes(to) ?? false;
}
