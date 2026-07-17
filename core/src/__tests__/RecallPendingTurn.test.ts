import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { recallPendingTurn } from "../use-cases/RecallPendingTurn.ts";
import type { EventRepo } from "../ports/EventRepo.ts";
import type { TurnOutputTracker } from "../ports/TurnOutputTracker.ts";
import { fakeQueue } from "./helpers/fakeMessageQueue.ts";

// Stateful tracker double mirroring TurnOutputTrackerService: {seen, recallRowId}
// per the port — recall must consume the target via reset().
const tracker = (init: { seen?: boolean; rowId?: number | null } = {}) => {
  const state = { seen: init.seen ?? false, recallRowId: init.rowId ?? null };
  const t: TurnOutputTracker = {
    reset: () => { state.seen = false; state.recallRowId = null; },
    setRecallRow: (_w, id) => { state.recallRowId = id; },
    markSeen: () => { state.seen = true; },
    seen: () => state.seen,
    recallRowId: () => state.recallRowId,
  };
  return { t, state };
};

const events = (rows: Array<{ id: number; type: string; payload: string | null }>): EventRepo => {
  const mapped = () => rows.map((r) => ({ id: r.id, worker_id: "w1", ts: r.id, type: r.type, payload: r.payload }));
  return {
    append: () => 0,
    patchPayload: () => {},
    list: ({ order, limit }) => {
      const asc = mapped();
      return order === "desc" ? asc.slice(-limit) : asc;
    },
    findById: (_workerId, rowId) => mapped().find((r) => r.id === rowId) ?? null,
    deleteByWorker: () => {},
  };
};

const userMsg = (id: number, text: string, clientMsgIds?: string[]) => ({
  id,
  type: "user_message",
  payload: JSON.stringify({ text, ...(clientMsgIds ? { clientMsgIds } : {}) }),
});

describe("recallPendingTurn", () => {
  it("output already seen this turn → no recall (normal interrupt)", () => {
    const queue = fakeQueue();
    const r = recallPendingTurn(
      { events: events([userMsg(1, "hi", ["c1"])]), queue: queue.repo, turnOutput: tracker({ seen: true, rowId: 1 }).t },
      "w1",
    );
    assert.deepEqual(r, { recalled: false });
  });

  // The wrong-message bug: a turn started by an agent-plane dispatch
  // (orchestrator_message / worker_report / loop / …) resets the tracker but
  // attaches NO recall row — older, already-answered user_messages in the log
  // must never be recalled, even though seen is false.
  it("no recall target (agent-plane turn) → no recall despite older user_messages", () => {
    const queue = fakeQueue();
    queue.repo.insert({ workerId: "w1", clientMsgId: "c0", text: "old", createdAt: 1, dispatchedAt: 1 });
    const r = recallPendingTurn(
      { events: events([userMsg(1, "old", ["c0"]), { id: 2, type: "orchestrator_message", payload: "{}" }]), queue: queue.repo, turnOutput: tracker({ rowId: null }).t },
      "w1",
    );
    assert.deepEqual(r, { recalled: false });
    assert.equal(queue.rows.length, 1, "the old ledger row is untouched");
  });

  it("output empty + target set → recalls EXACTLY that row and drops its dispatched ledger row", () => {
    const queue = fakeQueue();
    // The dispatched claim row a keyed send leaves behind (DispatchMessage).
    queue.repo.insert({ workerId: "w1", clientMsgId: "c1", text: "hi", createdAt: 1, dispatchedAt: 1 });
    const r = recallPendingTurn(
      { events: events([userMsg(1, "first", ["c0"]), userMsg(5, "hi", ["c1"])]), queue: queue.repo, turnOutput: tracker({ rowId: 5 }).t },
      "w1",
    );
    assert.deepEqual(r, { recalled: true, text: "hi", clientMsgId: "c1", rowId: 5 });
    assert.equal(queue.rows.length, 0, "the dispatched ledger row for c1 is dropped");
  });

  // By-id, not by-position: even with user_messages before AND after in the log,
  // only the tracker's row is recalled.
  it("recalls the tracker's row, never a neighbor", () => {
    const queue = fakeQueue();
    const r = recallPendingTurn(
      {
        events: events([userMsg(1, "old", ["c0"]), userMsg(7, "mine", ["c1"]), userMsg(9, "other", ["c2"])]),
        queue: queue.repo,
        turnOutput: tracker({ rowId: 7 }).t,
      },
      "w1",
    );
    assert.deepEqual(r, { recalled: true, text: "mine", clientMsgId: "c1", rowId: 7 });
  });

  it("keyless send → recalls text + rowId, no clientMsgId, leaves the unaddressable audit row", () => {
    const queue = fakeQueue();
    queue.repo.insert({ workerId: "w1", clientMsgId: null, text: "anon", createdAt: 1, dispatchedAt: 1 });
    const r = recallPendingTurn(
      { events: events([userMsg(3, "anon")]), queue: queue.repo, turnOutput: tracker({ rowId: 3 }).t },
      "w1",
    );
    assert.deepEqual(r, { recalled: true, text: "anon", rowId: 3 });
    assert.equal(queue.rows.length, 1, "the keyless audit row is left as a harmless breadcrumb");
  });

  it("target row gone from the log (pruned) → no recall", () => {
    const queue = fakeQueue();
    const r = recallPendingTurn(
      { events: events([{ id: 1, type: "state", payload: "{}" }]), queue: queue.repo, turnOutput: tracker({ rowId: 99 }).t },
      "w1",
    );
    assert.deepEqual(r, { recalled: false });
  });

  it("a recall consumes the target — a second interrupt recalls nothing", () => {
    const queue = fakeQueue();
    const { t, state } = tracker({ rowId: 5 });
    const deps = { events: events([userMsg(5, "hi", ["c1"])]), queue: queue.repo, turnOutput: t };
    const first = recallPendingTurn(deps, "w1");
    assert.equal(first.recalled, true);
    assert.equal(state.recallRowId, null, "target consumed");
    assert.deepEqual(recallPendingTurn(deps, "w1"), { recalled: false });
  });
});
