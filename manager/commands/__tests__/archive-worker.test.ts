import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { archiveWorkerHandler } from "../handlers/archive-worker.ts";
import type { Container } from "../../container.ts";
import { PermissionDeniedError } from "../../../core/src/errors/index.ts";

// Minimal fake container exercising ONLY what the archive handler touches.
// Tree: orch-1 → w1 (WORKING, supervised PTY) → w2 (IDLE, in-process sdk).
function harness() {
  type Row = {
    id: string; name: string | null; parent_id: string | null; state: string;
    pid: number | null; backend_kind: string; archived_at: number | null;
  };
  const rows: Row[] = [
    { id: "w1", name: "parent", parent_id: "orch-1", state: "WORKING", pid: 10, backend_kind: "claude-cli", archived_at: null },
    { id: "w2", name: "child", parent_id: "w1", state: "IDLE", pid: null, backend_kind: "claude-sdk", archived_at: null },
  ];
  const byId = (id: string) => rows.find((r) => r.id === id) ?? null;

  const setArchived: Array<{ id: string; ts: number | null }> = [];
  const markedDone: string[] = [];
  const runtimeCleared: string[] = [];
  const pendingDeleted: string[] = [];
  const queueDeleted: string[] = [];
  const escalated: string[] = [];
  const backendStopped: string[] = [];
  const cancelled: Record<string, string[]> = { questions: [], peers: [], activity: [] };
  const published: Array<{ topic: string; payload: unknown }> = [];

  const session = { stop: () => {} };
  const c = {
    workers: {
      findById: byId,
      findChildrenIds: (pid: string) => rows.filter((r) => r.parent_id === pid).map((r) => r.id),
      setArchived: (id: string, ts: number | null) => { setArchived.push({ id, ts }); const r = byId(id); if (r) r.archived_at = ts; },
      clearRuntime: (id: string) => { runtimeCleared.push(id); },
      markDone: (id: string) => { markedDone.push(id); const r = byId(id); if (r) r.state = "DONE"; },
    },
    pending: { deleteByWorker: (id: string) => { pendingDeleted.push(id); } },
    messageQueue: { deleteByWorker: (id: string) => { queueDeleted.push(id); } },
    bus: { publish: (topic: string, payload: unknown) => { published.push({ topic, payload }); } },
    clock: { now: () => 5000 },
    supervisor: {
      has: (id: string) => id === "w1",
      escalateKill: (id: string) => { escalated.push(id); },
      killPid: () => {},
      findPidsByPattern: () => [],
    },
    backends: {
      has: () => true,
      get: () => ({ attach: (wid: string) => ({ ...session, stop: () => { backendStopped.push(wid); } }) }),
    },
    pendingQuestions: { cancelByWorker: (id: string) => { cancelled.questions.push(id); } },
    pendingPeerRequests: { cancelByWorker: (id: string) => { cancelled.peers.push(id); } },
    backgroundActivity: { clearWorker: (id: string) => { cancelled.activity.push(id); } },
  } as unknown as Container;

  const run = (addr: { id: string; actorId?: string }) =>
    archiveWorkerHandler.run(addr, undefined as never, { c } as never);
  return { run, setArchived, markedDone, runtimeCleared, pendingDeleted, queueDeleted, escalated, backendStopped, cancelled, published };
}

describe("archiveWorkerHandler", () => {
  it("rejects a foreign actorId before any side effect", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = harness();
    await assert.rejects(h.run({ id: "w1", actorId: "orch-OTHER" }), PermissionDeniedError);
    assert.equal(h.setArchived.length, 0, "no archive stamp on a denied request");
    assert.equal(h.escalated.length, 0, "no process touched on a denied request");
  });

  it("happy path: subtree stamped depth-first, response carries {id, archived[], was_state}", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = harness();
    const res = await h.run({ id: "w1", actorId: "orch-1" });
    assert.deepEqual(res, { status: 200, body: { id: "w1", archived: ["w2", "w1"], was_state: "WORKING" } });
    assert.deepEqual(h.setArchived, [{ id: "w2", ts: 5000 }, { id: "w1", ts: 5000 }]);
    assert.deepEqual(h.runtimeCleared, ["w2", "w1"]);
    // WORKING parent settles to DONE; IDLE child too (not at rest).
    assert.deepEqual(h.markedDone, ["w2", "w1"]);
    const changes = h.published.filter((p) => p.topic === "worker:change");
    assert.deepEqual(changes.map((p) => p.payload), [
      { workerId: "w2", reason: "archived" },
      { workerId: "w1", reason: "archived" },
    ]);
    assert.ok(!h.published.some((p) => p.topic === "worker:removed"), "archive never publishes worker:removed");
  });

  it("supervised row gets escalateKill; unsupervised in-process row gets stopBackendSession", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = harness();
    await h.run({ id: "w1" });
    assert.deepEqual(h.escalated, ["w1"]);
    assert.deepEqual(h.backendStopped, ["w2"]);
  });

  it("cancels in-memory pendings per subtree row; queued_messages stay untouched", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = harness();
    await h.run({ id: "w1" });
    assert.deepEqual(h.cancelled.questions, ["w2", "w1"]);
    assert.deepEqual(h.cancelled.peers, ["w2", "w1"]);
    assert.deepEqual(h.cancelled.activity, ["w2", "w1"]);
    assert.deepEqual(h.pendingDeleted, ["w2", "w1"], "pending_permissions deleted per row");
    assert.equal(h.queueDeleted.length, 0, "undelivered user text survives archive");
  });
});
