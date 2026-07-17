// TurnOutputTracker — per-worker, in-memory turn state for the recall decision:
// "has the current turn produced any visible output yet?" plus the id of the
// exact user_message row the turn's dispatch appended — the ONLY row an
// interrupt may recall. RecallPendingTurn reads both (no output AND a known
// row → recall that row; otherwise a normal interrupt).
//
// The signal MUST be in-memory, fed by the daemon's live delta sink — NOT the
// durable event log: live deltas are never logged (ProcessAgentSignal drops
// them), so a turn streaming visible reasoning/text would be misclassified
// "no output" by a log-based check. Reset at dispatch (the turn's push); the
// recall row is attached separately AFTER the send, when the daemon appends the
// user_message row (its id doesn't exist at reset time, and a failed send must
// leave nothing recallable). Agent-plane dispatches (orchestrator_message /
// worker_report / loop / …) never attach a row, so a turn they started can
// never recall an older, answered user_message — by construction. Marked seen
// on the FIRST delta on EITHER channel (reasoning OR text) or the first
// assistant message. The daemon owns the implementation and core depends only
// on this abstraction (DIP).
export interface TurnOutputTracker {
  /** Turn boundary: a new message was dispatched — clear the output flag and
   *  the recall target for this worker. */
  reset(workerId: string): void;
  /** Attach the current turn's recall target: the user_message row this
   *  dispatch appended. Only plain user dispatches ever call it. */
  setRecallRow(workerId: string, rowId: number): void;
  /** The agent produced output this turn (first delta / assistant message). */
  markSeen(workerId: string): void;
  /** True once output was seen since the last reset. */
  seen(workerId: string): boolean;
  /** The row an interrupt may recall this turn, or null (agent-plane turn,
   *  no dispatch yet, or already recalled). */
  recallRowId(workerId: string): number | null;
}
