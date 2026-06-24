import type { TurnOutputTracker } from "../../core/src/ports/TurnOutputTracker.ts";

// Per-worker "has the current turn produced visible output yet?" flag — fed by
// the daemon's live agent-event sink (container.ts onAgentEvent): reset at the
// dispatch push (DispatchMessage), marked seen on the FIRST delta on either
// channel (reasoning OR text) or the first assistant message. RecallPendingTurn
// reads seen() to decide whether an interrupt may recall the just-sent message.
//
// In-memory by necessity: live deltas are never durably logged (ProcessAgentSignal
// drops them), so a turn streaming visible reasoning would be misclassified
// "no output" by any log-based check. Sibling of TurnSettleService — the daemon
// owns turn liveness.
export class TurnOutputTrackerService implements TurnOutputTracker {
  private readonly seenByWorker = new Map<string, boolean>();

  reset(workerId: string): void {
    this.seenByWorker.set(workerId, false);
  }
  markSeen(workerId: string): void {
    this.seenByWorker.set(workerId, true);
  }
  seen(workerId: string): boolean {
    return this.seenByWorker.get(workerId) === true;
  }
}
