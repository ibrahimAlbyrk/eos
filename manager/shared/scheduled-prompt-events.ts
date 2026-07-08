// Scheduled-prompt lifecycle emit — the persist+broadcast pair for the three
// scheduled_prompt:* events. appendSynthesized persists the timeline row and
// publishes only "worker:change" (SseBroadcaster relays msg.topic as the SSE
// reason), so the event-type string never reaches the client on its own. This
// helper ALSO publishes the type as a bus topic — the fs:change pattern — so the
// wildcard SSE subscription surfaces it as its own reason and the web's
// scheduled list auto-refreshes. One call keeps the pair from drifting apart.

import type { SynthesizedEventDeps } from "./synthesized-events.ts";
import { appendSynthesized } from "./synthesized-events.ts";

export type ScheduledPromptEventType =
  | "scheduled_prompt:created"
  | "scheduled_prompt:fired"
  | "scheduled_prompt:cancelled";

export function emitScheduledPromptEvent(
  deps: SynthesizedEventDeps,
  type: ScheduledPromptEventType,
  workerId: string,
  id: string,
  extra: Record<string, unknown> = {},
): void {
  appendSynthesized(deps, workerId, type, { id, ...extra });
  deps.bus.publish(type, { workerId, id });
}
