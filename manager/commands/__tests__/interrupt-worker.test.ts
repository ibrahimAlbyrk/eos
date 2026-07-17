import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { interruptWorkerHandler } from "../handlers/interrupt-worker.ts";
import type { Container } from "../../container.ts";
import { TurnOutputTrackerService } from "../../services/TurnOutputTracker.ts";
import { dispatchMessage, type DispatchMessageDeps } from "../../../core/src/use-cases/DispatchMessage.ts";
import { fakeQueue } from "../../../core/src/__tests__/helpers/fakeMessageQueue.ts";

// End-to-end harness: messages go through the REAL dispatchMessage (which resets
// the tracker and attaches the recall row exactly as production does), then the
// REAL interrupt handler runs against the same tracker/events/queue. This is the
// reproduction path of the wrong-message recall bug — an agent-plane dispatch
// starting the interrupted turn must not recall an older user message.
function harness(opts: { reportsMessageEvents?: boolean } = {}) {
  const eventRows: Array<{ id: number; type: string; payload: string | null }> = [];
  let nextId = 1;
  const published: Array<{ topic: string; payload: unknown }> = [];
  let workerState = "IDLE";
  let recallCalls = 0;

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
    findById: (_w: string, rowId: number) => {
      const r = eventRows.find((row) => row.id === rowId);
      return r ? { id: r.id, worker_id: "w1", ts: r.id, type: r.type, payload: r.payload } : null;
    },
    deleteByWorker: () => {},
  };
  const queue = fakeQueue();
  const turnOutput = new TurnOutputTrackerService();

  const session = {
    isAlive: () => true,
    capabilities: { interrupt: true, reportsMessageEvents: opts.reportsMessageEvents ?? false },
    sendMessage: async () => ({ ok: true, status: 200, body: { ok: true } }),
    interrupt: async () => ({ ok: true }),
    recallLastUserTurn: async () => { recallCalls++; return { ok: true }; },
  };
  const backend = { descriptor: { processModel: "in-process" }, attach: () => session };

  const workers = {
    findById: (id: string) => (id === "w1" ? { id: "w1", backend_kind: "claude-sdk", port: null, pid: null, state: workerState, is_orchestrator: 0 } : undefined),
    updateState: (_id: string, next: string) => { workerState = next; },
    setTurnStartedAt: () => {},
  };
  const bus = { publish: (topic: string, payload: unknown) => { published.push({ topic, payload }); } };
  const clock = { now: () => 1000 };
  const log = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };
  const backends = { has: () => true, get: () => backend };

  const dispatchDeps = {
    workers, events, bus, clock, queue: queue.repo,
    client: { sendMessage: async () => ({ ok: true, status: 200, body: { ok: true } }) },
    backends, log, isLive: () => true, turnOutput,
  } as unknown as DispatchMessageDeps;

  const c = {
    workers, events, bus, clock, log, backends,
    claudeCliBackend: backend,
    messageQueue: queue.repo,
    pendingPeerRequests: { cancelByWorker: () => {} },
    turnSettle: { mark: () => {} },
    turnOutput,
  } as unknown as Container;

  return {
    dispatchUser: (text: string, clientMsgId: string) =>
      dispatchMessage(dispatchDeps, { workerId: "w1", text, clientMsgId }),
    dispatchAgent: (text: string) =>
      dispatchMessage(dispatchDeps, { workerId: "w1", text, envelope: { kind: "orchestrator_message", fromParent: "o1", parentName: "boss" } }),
    markSeen: () => turnOutput.markSeen("w1"),
    interrupt: () => interruptWorkerHandler.run({ id: "w1" }, undefined as never, { c } as never),
    eventRows, published, queue,
    recalledEvents: () => eventRows.filter((e) => e.type === "message_recalled"),
    get recallCalls() { return recallCalls; },
    get workerState() { return workerState; },
  };
}

describe("interruptWorkerHandler — recall", () => {
  it("user dispatch, no output yet → recalls exactly that row, drops its ledger row, runs Layer-2 rollback", async () => {
    const h = harness();
    // An earlier, ANSWERED user message sits in the log.
    await h.dispatchUser("old answered", "c0");
    h.markSeen();
    // The turn being interrupted: a fresh user message, no output yet.
    await h.dispatchUser("draft to restore", "c1");
    const draftRow = h.eventRows.find((e) => e.type === "user_message" && (JSON.parse(e.payload!) as { text: string }).text === "draft to restore")!;

    const res = await h.interrupt();
    assert.deepEqual(res, { status: 200, body: { ok: true } });
    const recalled = h.recalledEvents();
    assert.equal(recalled.length, 1);
    assert.deepEqual(JSON.parse(recalled[0].payload!), { text: "draft to restore", clientMsgId: "c1", recalledRowId: draftRow.id });
    const pub = h.published.find((p) => p.topic === "message:recalled");
    assert.deepEqual(pub?.payload, { workerId: "w1", text: "draft to restore", clientMsgId: "c1" });
    assert.ok(!h.queue.rows.some((r) => r.clientMsgId === "c1"), "dispatched ledger row for c1 dropped");
    assert.ok(h.queue.rows.some((r) => r.clientMsgId === "c0"), "the answered message's row untouched");
    assert.equal(h.recallCalls, 1, "Layer-2 recallLastUserTurn invoked");
    assert.equal(h.workerState, "IDLE", "normal interrupt still transitions to IDLE");
  });

  // The reported bug: the interrupted turn was started by an agent-plane
  // dispatch. seen is false (no output yet) — but nothing may be recalled: not
  // the event emit, not the bus push, not the SDK-transcript rollback.
  it("agent-plane dispatch, no output yet → NO recall of the older user message", async () => {
    const h = harness();
    await h.dispatchUser("old answered", "c0");
    h.markSeen();
    await h.dispatchAgent("directive: do X");

    await h.interrupt();
    assert.deepEqual(h.recalledEvents(), [], "no message_recalled emit");
    assert.ok(!h.published.some((p) => p.topic === "message:recalled"), "no message:recalled publish");
    assert.equal(h.recallCalls, 0, "no SDK-transcript rollback");
    assert.ok(h.queue.rows.some((r) => r.clientMsgId === "c0"), "old ledger row untouched");
    assert.equal(h.workerState, "IDLE", "still a normal interrupt");
  });

  it("output already seen (first delta) → no recall, normal interrupt only", async () => {
    const h = harness();
    await h.dispatchUser("hi", "c1");
    h.markSeen();

    await h.interrupt();
    assert.deepEqual(h.recalledEvents(), []);
    assert.ok(!h.published.some((p) => p.topic === "message:recalled"));
    assert.equal(h.recallCalls, 0);
    assert.ok(h.queue.rows.some((r) => r.clientMsgId === "c1"), "ledger row untouched");
    assert.equal(h.workerState, "IDLE");
  });

  it("a second interrupt never recalls the same row again", async () => {
    const h = harness();
    await h.dispatchUser("draft", "c1");

    await h.interrupt();
    await h.interrupt();
    assert.equal(h.recalledEvents().length, 1, "exactly one message_recalled");
    assert.equal(h.recallCalls, 1, "exactly one Layer-2 rollback");
  });

  it("claude-cli lane (reportsMessageEvents) → never recalls even when output empty", async () => {
    const h = harness({ reportsMessageEvents: true });
    await h.dispatchUser("draft", "c1");

    await h.interrupt();
    assert.deepEqual(h.recalledEvents(), []);
    assert.equal(h.recallCalls, 0);
    assert.ok(h.queue.rows.some((r) => r.clientMsgId === "c1"));
  });
});
