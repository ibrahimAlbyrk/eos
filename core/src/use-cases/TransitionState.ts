// Centralized state transition — wraps `canTransition` + repo update + event
// append + bus publish. Every "set worker state X" call site in the daemon
// goes through this so the FSM contract is enforced once.

import type { WorkerState } from "../../../contracts/src/events.ts";
import { canTransition } from "../domain/state-machine.ts";
import type { WorkerRepo } from "../ports/WorkerRepo.ts";
import type { EventRepo } from "../ports/EventRepo.ts";
import type { EventBus } from "../ports/EventBus.ts";
import type { Clock } from "../ports/Clock.ts";

export interface TransitionStateDeps {
  workers: WorkerRepo;
  events: EventRepo;
  bus: EventBus;
  clock: Clock;
}

export interface TransitionInput {
  workerId: string;
  next: WorkerState;
  reason: string;
}

const BUSY_STATES = new Set<WorkerState>(["SPAWNING", "WORKING"]);

export function transitionState(deps: TransitionStateDeps, input: TransitionInput): "applied" | "rejected" | "noop" {
  const cur = deps.workers.findById(input.workerId);
  if (!cur) return "noop";
  const from = String(cur.state).toUpperCase() as WorkerState;
  if (from === input.next) return "noop";
  if (!canTransition(from, input.next)) {
    const rowId = deps.events.append(input.workerId, deps.clock.now(), "state_reject", {
      from, to: input.next, reason: input.reason,
    });
    deps.bus.publish("worker:change", { workerId: input.workerId, rowId });
    return "rejected";
  }
  deps.workers.updateState(input.workerId, input.next);
  // Turn clock: stamp on every entry into the busy set from a non-busy state.
  // Busy-internal moves (SPAWNING→WORKING) keep the original stamp so the UI
  // elapsed covers the whole turn, not just the latest sub-phase.
  if (!BUSY_STATES.has(from) && BUSY_STATES.has(input.next)) {
    deps.workers.setTurnStartedAt(input.workerId, deps.clock.now());
  }
  const rowId = deps.events.append(input.workerId, deps.clock.now(), "state", {
    state: input.next, from, reason: input.reason,
  });
  deps.bus.publish("worker:change", { workerId: input.workerId, rowId, from, state: input.next });
  return "applied";
}
