// Which update phase may follow which — the rule book UpdateService drives;
// a move not listed here is refused. `off` has no ways in or out: a build from
// source stays off for its whole life. Applying never reaches a later phase
// here: on success the app quits and the new version starts fresh.

import type { UpdatePhase } from "../../../../contracts/src/update.ts";

export const UPDATE_TRANSITIONS: Record<UpdatePhase, ReadonlyArray<UpdatePhase>> = {
  off:         [],
  idle:        ["checking"],
  // ready: this version was staged before the daemon restarted.
  checking:    ["idle", "available", "downloading", "ready", "error"],
  available:   ["checking", "downloading"],
  // available: downloading was cancelled or turned off.
  downloading: ["staging", "available", "error"],
  // available: cancelled while the bundle was being built.
  staging:     ["ready", "available", "error"],
  // checking: a newer release may have appeared meanwhile.
  ready:       ["checking", "waiting", "applying"],
  waiting:     ["applying", "ready"],
  applying:    ["error"],
  error:       ["checking", "idle"],
};

export function canUpdateTransition(from: UpdatePhase, to: UpdatePhase): boolean {
  if (from === to) return true;
  return UPDATE_TRANSITIONS[from].includes(to);
}
