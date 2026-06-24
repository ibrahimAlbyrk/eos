// LoopProgressSink — the live goal-check progress seam. runLoopTick reports each
// phase of a tick (started → verifying | judging → verdict) through this plain
// callback; the manager adapter (in GoalLoopService) turns each update into a
// "loop:check" bus payload SseBroadcaster relays to the UI, and persists the
// verdict as a "loop_check" timeline event. Core stays ignorant of the bus.

import type { LoopCheckProgress } from "../../../contracts/src/loop.ts";

// What runLoopTick reports — the full transient payload minus the workerId the
// manager adds from its closure.
export type LoopProgressUpdate = Omit<LoopCheckProgress, "workerId">;
export type LoopProgressSink = (update: LoopProgressUpdate) => void;

// What a strategy reports as it runs: just its running phase plus, optionally, the
// criterion it is verifying. runLoopTick enriches these with attempt/strategy
// before forwarding to the sink, so strategies stay ignorant of loop bookkeeping.
export type StrategyProgressSink = (update: {
  phase: "verifying" | "judging";
  criterionId?: string;
}) => void;
