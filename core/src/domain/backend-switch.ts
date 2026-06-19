// Backend-switch decision — pure domain rules for moving a RUNNING worker's
// conversation from one provider (backend) to another. Two layers:
//   canHandoffBackend — can these two backends share a conversation at all?
//   planBackendSwitch — given the live worker's state, is a switch allowed now,
//                       and does the old session need stopping first?
// All decision logic lives here (no I/O) so the manager helper is pure mechanism
// (stop → wait → resume). Consumers branch on BackendDescriptor data, never on a
// kind literal.

import type { BackendDescriptor } from "../ports/AgentBackend.ts";

export type HandoffCheck = { ok: true } | { ok: false; reason: string };

// A switch on a busy/transitional worker would lose the in-flight turn (provider
// switch can't be applied live like a model switch) — only at-rest states qualify.
const SWITCH_BLOCKED_STATES = new Set(["WORKING", "SPAWNING", "ENDING", "KILLING"]);

// Can a worker move its conversation from `source` to `target`? Only when both
// share a non-"none" sessionStore (mutually-loadable transcript) and the target
// is a distinct, enabled provider.
export function canHandoffBackend(source: BackendDescriptor, target: BackendDescriptor): HandoffCheck {
  if (source.kind === target.kind) return { ok: false, reason: "worker is already on this backend" };
  if (!target.enabled) return { ok: false, reason: `backend "${target.kind}" is not enabled` };
  if (source.sessionStore === "none" || target.sessionStore === "none") {
    return { ok: false, reason: "one of the backends keeps no resumable conversation store" };
  }
  if (source.sessionStore !== target.sessionStore) {
    return { ok: false, reason: "the backends use incompatible conversation stores" };
  }
  return { ok: true };
}

export type SwitchPlan =
  | { ok: false; reason: string }
  | { ok: true; needsStop: boolean };

// Decide whether the switch can proceed right now. `needsStop` tells the executor
// whether the old session is still live and must be torn down before the resume.
export function planBackendSwitch(input: {
  state: string;
  sessionId: string | null;
  isLive: boolean;
  source: BackendDescriptor;
  target: BackendDescriptor;
}): SwitchPlan {
  const handoff = canHandoffBackend(input.source, input.target);
  if (!handoff.ok) return handoff;
  if (!input.sessionId) return { ok: false, reason: "worker has no recorded session to hand off" };
  if (SWITCH_BLOCKED_STATES.has(input.state)) {
    return { ok: false, reason: `worker is busy (state ${input.state}) — interrupt or wait for the turn to finish` };
  }
  return { ok: true, needsStop: input.isLive };
}
