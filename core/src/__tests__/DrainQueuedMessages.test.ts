import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { drainQueuedMessages, type DrainQueuedMessagesDeps } from "../use-cases/DrainQueuedMessages.ts";
import type { DispatchMessageInput } from "../use-cases/DispatchMessage.ts";
import type { WorkerRow } from "../../../contracts/src/worker.ts";
import { fakeQueue } from "./helpers/fakeMessageQueue.ts";

function buildDeps(opts: { state?: string; dispatchError?: Error } = {}): {
  deps: DrainQueuedMessagesDeps;
  dispatched: DispatchMessageInput[];
  settleCleared: string[];
  queue: ReturnType<typeof fakeQueue>;
} {
  const dispatched: DispatchMessageInput[] = [];
  const settleCleared: string[] = [];
  const queue = fakeQueue();
  const deps: DrainQueuedMessagesDeps = {
    workers: {
      findById: () => ({ id: "w1", state: opts.state ?? "IDLE" }) as unknown as WorkerRow,
    } as unknown as DrainQueuedMessagesDeps["workers"],
    queue: queue.repo,
    clock: { now: () => 5000 },
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => ({} as never) },
    clearTurnSettle: (id) => { settleCleared.push(id); },
    dispatch: async (input) => {
      if (opts.dispatchError) throw opts.dispatchError;
      dispatched.push(input);
      return { status: 200, body: { ok: true } };
    },
  };
  return { deps, dispatched, settleCleared, queue };
}

const enqueue = (q: ReturnType<typeof fakeQueue>, text: string, clientMsgId: string | null): void => {
  q.repo.insert({ workerId: "w1", clientMsgId, text, createdAt: 1000, dispatchedAt: null });
};

describe("drainQueuedMessages", () => {
  it("combines pending rows into one dispatch and marks them dispatched", async () => {
    const { deps, dispatched, settleCleared, queue } = buildDeps();
    enqueue(queue, "first", "c1");
    enqueue(queue, "second", "c2");
    const outcome = await drainQueuedMessages(deps, { workerId: "w1" });
    assert.equal(outcome, "dispatched");
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].text, "first\n\nsecond");
    assert.deepEqual(dispatched[0].recordClientMsgIds, ["c1", "c2"]);
    assert.equal(dispatched[0].origin, "queue-drain");
    assert.deepEqual(settleCleared, ["w1"]);
    assert.equal(queue.repo.listPending("w1").length, 0);
    assert.ok(queue.rows.every((r) => r.dispatchedAt === 5000));
  });

  it("rows without clientMsgId still drain (no ids in the record)", async () => {
    const { deps, dispatched, queue } = buildDeps();
    enqueue(queue, "anon", null);
    await drainQueuedMessages(deps, { workerId: "w1" });
    assert.deepEqual(dispatched[0].recordClientMsgIds, []);
  });

  it("not IDLE → no dispatch, rows stay pending", async () => {
    const { deps, dispatched, queue } = buildDeps({ state: "WORKING" });
    enqueue(queue, "later", "c1");
    const outcome = await drainQueuedMessages(deps, { workerId: "w1" });
    assert.equal(outcome, "not-idle");
    assert.equal(dispatched.length, 0);
    assert.equal(queue.repo.listPending("w1").length, 1);
  });

  it("empty queue → empty, settle untouched", async () => {
    const { deps, settleCleared } = buildDeps();
    const outcome = await drainQueuedMessages(deps, { workerId: "w1" });
    assert.equal(outcome, "empty");
    assert.deepEqual(settleCleared, []);
  });

  it("dispatch failure leaves rows pending for the next IDLE", async () => {
    const { deps, queue } = buildDeps({ dispatchError: new Error("worker unreachable") });
    enqueue(queue, "retry me", "c1");
    const outcome = await drainQueuedMessages(deps, { workerId: "w1" });
    assert.equal(outcome, "failed");
    assert.equal(queue.repo.listPending("w1").length, 1);
  });
});
