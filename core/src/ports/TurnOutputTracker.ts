// TurnOutputTracker — per-worker, in-memory "has the current turn produced any
// visible output yet?" signal. RecallPendingTurn reads it to decide whether an
// interrupt may recall the just-sent message (no output → recall; output → the
// agent heard it, normal interrupt).
//
// The signal MUST be in-memory, fed by the daemon's live delta sink — NOT the
// durable event log: live deltas are never logged (ProcessAgentSignal drops
// them), so a turn streaming visible reasoning/text would be misclassified
// "no output" by a log-based check. Reset at dispatch (the turn's push), marked
// seen on the FIRST delta on EITHER channel (reasoning OR text) or the first
// assistant message. The daemon owns the implementation (Map<workerId, boolean>)
// and core depends only on this abstraction (DIP).
export interface TurnOutputTracker {
  /** Turn boundary: a new message was dispatched — clear the flag for this worker. */
  reset(workerId: string): void;
  /** The agent produced output this turn (first delta / assistant message). */
  markSeen(workerId: string): void;
  /** True once output was seen since the last reset. */
  seen(workerId: string): boolean;
}
