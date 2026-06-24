import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { interruptWorkerHandler } from "../handlers/interrupt-worker.ts";
import type { Container } from "../../container.ts";
import { TurnOutputTrackerService } from "../../services/TurnOutputTracker.ts";
import { fakeQueue } from "../../../core/src/__tests__/helpers/fakeMessageQueue.ts";

// Minimal fake container exercising ONLY what the interrupt handler touches.
// reportsMessageEvents flips the lane: false = SDK (daemon owns the user_message
// row → recall eligible); true = claude-cli (self-reports → never recalls).
function harness(opts: { reportsMessageEvents: boolean; outputSeen: boolean }) {
  const eventRows: Array<{ id: number; type: string; payload: string | null }> = [];
  let nextId = 1;
  const published: Array<{ topic: string; payload: unknown }> = [];
  let workerState = "WORKING";
  let recallCalled = false;

  const events = {
    append: (_w: string, _ts: number, type: string, payload: unknown) => {
      const id = nextId++;
      eventRows.push({ id, type, payload: JSON.stringify(payload) });
      return id;
    },
    patchPayload: () => {},
    list: ({ order }: { order: "asc" | "desc" }) => {
      const m = eventRows.map((r) => ({ id: r.id, worker_id: "w1", ts: r.id, type: r.type, payload: r.payload }));
      return order === "desc" ? m.slice().reverse() : m;
    },
    deleteByWorker: () => {},
  };
  // Seed the just-dispatched bubble + its dispatched ledger claim row.
  events.append("w1", 0, "user_message", { text: "draft to restore", clientMsgIds: ["c1"] });
  const queue = fakeQueue();
  queue.repo.insert({ workerId: "w1", clientMsgId: "c1", text: "draft to restore", createdAt: 1, dispatchedAt: 1 });

  const turnOutput = new TurnOutputTrackerService();
  turnOutput.reset("w1");
  if (opts.outputSeen) turnOutput.markSeen("w1");

  const session = {
    isAlive: () => true,
    capabilities: { interrupt: true, reportsMessageEvents: opts.reportsMessageEvents },
    interrupt: async () => ({ ok: true }),
    recallLastUserTurn: async () => { recallCalled = true; return { ok: true }; },
  };
  const backend = { descriptor: { processModel: "in-process" }, attach: () => session };

  const c = {
    workers: {
      findById: (id: string) => (id === "w1" ? { id: "w1", backend_kind: "claude-sdk", port: null, pid: null, state: workerState } : undefined),
      updateState: (_id: string, next: string) => { workerState = next; },
      setTurnStartedAt: () => {},
    },
    events,
    bus: { publish: (topic: string, payload: unknown) => { published.push({ topic, payload }); } },
    clock: { now: () => 1000 },
    log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
    backends: { has: () => true, get: () => backend },
    claudeCliBackend: backend,
    messageQueue: queue.repo,
    pendingPeerRequests: { cancelByWorker: () => {} },
    turnSettle: { mark: () => {} },
    turnOutput,
  } as unknown as Container;

  const run = () => interruptWorkerHandler.run({ id: "w1" }, undefined as never, { c } as never);
  return { run, eventRows, published, queue, get recallCalled() { return recallCalled; }, get workerState() { return workerState; } };
}

describe("interruptWorkerHandler — recall", () => {
  it("SDK lane, output empty → emits message_recalled, drops the ledger row, runs Layer-2 rollback", async () => {
    const h = harness({ reportsMessageEvents: false, outputSeen: false });
    const res = await h.run();
    assert.deepEqual(res, { status: 200, body: { ok: true } });
    assert.ok(h.eventRows.some((e) => e.type === "message_recalled"), "message_recalled event appended");
    const recalled = h.eventRows.find((e) => e.type === "message_recalled");
    assert.deepEqual(JSON.parse(recalled!.payload!), { text: "draft to restore", clientMsgId: "c1", recalledRowId: 1 });
    const pub = h.published.find((p) => p.topic === "message:recalled");
    assert.deepEqual(pub?.payload, { workerId: "w1", text: "draft to restore", clientMsgId: "c1" });
    assert.equal(h.queue.rows.length, 0, "dispatched ledger row for c1 dropped");
    assert.equal(h.recallCalled, true, "Layer-2 recallLastUserTurn invoked");
    assert.equal(h.workerState, "IDLE", "normal interrupt still transitions to IDLE");
  });

  it("SDK lane, output already seen → no recall, normal interrupt only", async () => {
    const h = harness({ reportsMessageEvents: false, outputSeen: true });
    await h.run();
    assert.ok(!h.eventRows.some((e) => e.type === "message_recalled"), "no message_recalled emit");
    assert.ok(!h.published.some((p) => p.topic === "message:recalled"), "no message:recalled publish");
    assert.equal(h.recallCalled, false, "Layer-2 not invoked");
    assert.equal(h.queue.rows.length, 1, "ledger row untouched");
    assert.equal(h.workerState, "IDLE", "still a normal interrupt");
  });

  it("claude-cli lane (reportsMessageEvents) → never recalls even when output empty", async () => {
    const h = harness({ reportsMessageEvents: true, outputSeen: false });
    await h.run();
    assert.ok(!h.eventRows.some((e) => e.type === "message_recalled"));
    assert.equal(h.recallCalled, false);
    assert.equal(h.queue.rows.length, 1);
  });
});
