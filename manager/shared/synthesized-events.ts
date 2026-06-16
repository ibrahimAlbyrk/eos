// Daemon-synthesized timeline events (git_push, try_*, conversation_*,
// peer_consult, question_*, …) are appended directly by their route — there is
// no central dispatcher for them (unlike worker-pushed events, which go through
// ProcessWorkerEvent). Every such append must be followed by a worker:change
// publish or the UI never refreshes; doing that by hand at ~12 call sites
// invited the "forgot to publish" footgun. This helper makes the pair atomic:
// append the row, publish the change, return the row id — one call, impossible
// to half-do.

import type { EventRepo } from "../../core/src/ports/EventRepo.ts";
import type { EventBus } from "../../core/src/ports/EventBus.ts";
import type { Clock } from "../../core/src/ports/Clock.ts";
import type { WorkerEventType } from "../../contracts/src/events.ts";

export interface SynthesizedEventDeps {
  events: EventRepo;
  bus: EventBus;
  clock: Clock;
}

// notifyWorkerId defaults to the append target. Pass it when the event is
// recorded on one worker but a different worker's view must refresh — e.g.
// peer_consult is recorded on the asker yet refreshes the target's pane.
export function appendSynthesized(
  deps: SynthesizedEventDeps,
  workerId: string,
  type: WorkerEventType,
  payload: Record<string, unknown>,
  notifyWorkerId?: string,
): number {
  const rowId = deps.events.append(workerId, deps.clock.now(), type, payload);
  deps.bus.publish("worker:change", { workerId: notifyWorkerId ?? workerId, rowId });
  return rowId;
}
