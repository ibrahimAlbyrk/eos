import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { recallPendingTurn } from "../use-cases/RecallPendingTurn.ts";
import type { EventRepo } from "../ports/EventRepo.ts";
import type { TurnOutputTracker } from "../ports/TurnOutputTracker.ts";
import { fakeQueue } from "./helpers/fakeMessageQueue.ts";

const tracker = (seen: boolean): TurnOutputTracker => {
  let s = seen;
  return { reset: () => { s = false; }, markSeen: () => { s = true; }, seen: () => s };
};

// In-memory EventRepo whose list() honors the desc order the use-case asks for.
const events = (rows: Array<{ id: number; type: string; payload: string | null }>): EventRepo => ({
  append: () => 0,
  patchPayload: () => {},
  list: ({ order }) => {
    const mapped = rows.map((r) => ({ id: r.id, worker_id: "w1", ts: r.id, type: r.type, payload: r.payload }));
    return order === "desc" ? mapped.slice().reverse() : mapped;
  },
  deleteByWorker: () => {},
});

const userMsg = (id: number, text: string, clientMsgIds?: string[]) => ({
  id,
  type: "user_message",
  payload: JSON.stringify({ text, ...(clientMsgIds ? { clientMsgIds } : {}) }),
});

describe("recallPendingTurn", () => {
  it("output already seen this turn → no recall (normal interrupt)", () => {
    const queue = fakeQueue();
    const r = recallPendingTurn(
      { events: events([userMsg(1, "hi", ["c1"])]), queue: queue.repo, turnOutput: tracker(true) },
      "w1",
    );
    assert.deepEqual(r, { recalled: false });
  });

  it("output empty → recalls the LATEST user_message (text + clientMsgId + rowId) and drops its dispatched ledger row", () => {
    const queue = fakeQueue();
    // The dispatched claim row a keyed send leaves behind (DispatchMessage).
    queue.repo.insert({ workerId: "w1", clientMsgId: "c1", text: "hi", createdAt: 1, dispatchedAt: 1 });
    const r = recallPendingTurn(
      { events: events([userMsg(1, "first", ["c0"]), userMsg(5, "hi", ["c1"])]), queue: queue.repo, turnOutput: tracker(false) },
      "w1",
    );
    assert.deepEqual(r, { recalled: true, text: "hi", clientMsgId: "c1", rowId: 5 });
    assert.equal(queue.rows.length, 0, "the dispatched ledger row for c1 is dropped");
  });

  it("keyless send → recalls text + rowId, no clientMsgId, leaves the unaddressable audit row", () => {
    const queue = fakeQueue();
    queue.repo.insert({ workerId: "w1", clientMsgId: null, text: "anon", createdAt: 1, dispatchedAt: 1 });
    const r = recallPendingTurn(
      { events: events([userMsg(3, "anon")]), queue: queue.repo, turnOutput: tracker(false) },
      "w1",
    );
    assert.deepEqual(r, { recalled: true, text: "anon", rowId: 3 });
    assert.equal(queue.rows.length, 1, "the keyless audit row is left as a harmless breadcrumb");
  });

  it("no user_message in the log → no recall", () => {
    const queue = fakeQueue();
    const r = recallPendingTurn(
      { events: events([{ id: 1, type: "state", payload: "{}" }]), queue: queue.repo, turnOutput: tracker(false) },
      "w1",
    );
    assert.deepEqual(r, { recalled: false });
  });
});
