import type { TurnOutputTracker } from "../../core/src/ports/TurnOutputTracker.ts";

// Per-worker turn state for the recall decision — fed by the daemon's live
// agent-event sink (container.ts onAgentEvent): reset at the dispatch push
// (DispatchMessage), recall row attached when the daemon appends the turn's
// user_message row (plain user dispatches only — agent-plane envelopes attach
// none), marked seen on the FIRST delta on either channel (reasoning OR text)
// or the first assistant message. RecallPendingTurn reads seen()/recallRowId()
// to decide whether an interrupt may recall the just-sent message — and which
// exact row that is.
//
// In-memory by necessity: live deltas are never durably logged (ProcessAgentSignal
// drops them), so a turn streaming visible reasoning would be misclassified
// "no output" by any log-based check. Sibling of TurnSettleService — the daemon
// owns turn liveness.
export class TurnOutputTrackerService implements TurnOutputTracker {
  private readonly turns = new Map<string, { seen: boolean; recallRowId: number | null }>();

  reset(workerId: string): void {
    this.turns.set(workerId, { seen: false, recallRowId: null });
  }
  setRecallRow(workerId: string, rowId: number): void {
    const t = this.turns.get(workerId);
    if (t) t.recallRowId = rowId;
    else this.turns.set(workerId, { seen: false, recallRowId: rowId });
  }
  markSeen(workerId: string): void {
    const t = this.turns.get(workerId);
    if (t) t.seen = true;
    else this.turns.set(workerId, { seen: true, recallRowId: null });
  }
  seen(workerId: string): boolean {
    return this.turns.get(workerId)?.seen === true;
  }
  recallRowId(workerId: string): number | null {
    return this.turns.get(workerId)?.recallRowId ?? null;
  }
}
