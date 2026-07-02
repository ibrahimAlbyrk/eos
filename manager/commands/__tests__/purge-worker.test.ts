import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { purgeWorkerHandler } from "../handlers/purge-worker.ts";
import type { Container } from "../../container.ts";
import { ConflictError, PermissionDeniedError } from "../../../core/src/errors/index.ts";

// Tree: orch-1 → w1 (archived, worktree + session) → w2 (archived, plain cwd,
// no session). Cascade effects observed on fakes per row.
function harness(over?: { w1ArchivedAt?: number | null }) {
  type Row = {
    id: string; name: string | null; parent_id: string | null; state: string;
    archived_at: number | null; session_id: string | null;
    worktree_from: string | null; branch: string | null; worktree_dir: string | null;
  };
  const rows: Row[] = [
    {
      id: "w1", name: "victim", parent_id: "orch-1", state: "DONE",
      archived_at: over?.w1ArchivedAt !== undefined ? over.w1ArchivedAt : 5000,
      session_id: "sess-1", worktree_from: "/repo", branch: "eos-w1", worktree_dir: "/repo/.eos/worktrees/eos-w1",
    },
    {
      id: "w2", name: null, parent_id: "w1", state: "DONE", archived_at: 5000,
      session_id: null, worktree_from: null, branch: null, worktree_dir: null,
    },
  ];
  const alive = new Set(rows.map((r) => r.id));
  const deleted: string[] = [];
  const eventsDeleted: string[] = [];
  const pendingDeleted: string[] = [];
  const queueDeleted: string[] = [];
  const loopsDeleted: string[] = [];
  const conversationsDeleted: string[] = [];
  const mcpCleaned: string[] = [];
  const enqueued: Array<{ workerId: string; branch: string }> = [];
  const published: Array<{ topic: string; payload: unknown }> = [];

  const c = {
    workers: {
      findById: (id: string) => (alive.has(id) ? rows.find((r) => r.id === id) ?? null : null),
      findChildrenIds: (pid: string) => rows.filter((r) => alive.has(r.id) && r.parent_id === pid).map((r) => r.id),
      delete: (id: string) => { deleted.push(id); alive.delete(id); },
    },
    events: { deleteByWorker: (id: string) => { eventsDeleted.push(id); } },
    pending: { deleteByWorker: (id: string) => { pendingDeleted.push(id); } },
    messageQueue: { deleteByWorker: (id: string) => { queueDeleted.push(id); } },
    loops: { deleteByWorker: (id: string) => { loopsDeleted.push(id); } },
    deleteConversation: (sessionId: string) => { conversationsDeleted.push(sessionId); },
    bus: { publish: (topic: string, payload: unknown) => { published.push({ topic, payload }); } },
    cleanupMcpConfig: (id: string) => { mcpCleaned.push(id); },
    worktreeRemovals: { enqueue: (e: { workerId: string; branch: string }) => { enqueued.push({ workerId: e.workerId, branch: e.branch }); } },
    clock: { now: () => 9000 },
  } as unknown as Container;

  const run = (addr: { id: string; actorId?: string }) =>
    purgeWorkerHandler.run(addr, undefined as never, { c } as never);
  return { run, deleted, eventsDeleted, pendingDeleted, queueDeleted, loopsDeleted, conversationsDeleted, mcpCleaned, enqueued, published };
}

describe("purgeWorkerHandler", () => {
  it("rejects a non-archived target with ConflictError before any side effect", async () => {
    const h = harness({ w1ArchivedAt: null });
    await assert.rejects(h.run({ id: "w1" }), ConflictError);
    assert.equal(h.deleted.length, 0);
    assert.equal(h.loopsDeleted.length, 0);
  });

  it("rejects a foreign actorId before any side effect", async () => {
    const h = harness();
    await assert.rejects(h.run({ id: "w1", actorId: "orch-OTHER" }), PermissionDeniedError);
    assert.equal(h.deleted.length, 0);
  });

  it("happy path: full cascade per subtree row, response {id, removed, name}", async () => {
    const h = harness();
    const res = await h.run({ id: "w1", actorId: "orch-1" });
    assert.deepEqual(res, { status: 200, body: { id: "w1", removed: true, name: "victim" } });
    // Depth-first: child before parent, every table swept per row.
    assert.deepEqual(h.deleted, ["w2", "w1"]);
    assert.deepEqual(h.eventsDeleted, ["w2", "w1"]);
    assert.deepEqual(h.pendingDeleted, ["w2", "w1"]);
    assert.deepEqual(h.queueDeleted, ["w2", "w1"]);
    assert.deepEqual(h.loopsDeleted, ["w2", "w1"], "adopted leak: loop rows deleted");
    assert.deepEqual(h.mcpCleaned, ["w2", "w1"]);
    // Conversation delete keyed by session_id — only w1 has one.
    assert.deepEqual(h.conversationsDeleted, ["sess-1"]);
    // Worktree removal enqueued only for the row with worktree_from+branch.
    assert.deepEqual(h.enqueued, [{ workerId: "w1", branch: "eos-w1" }]);
    assert.deepEqual(
      h.published.filter((p) => p.topic === "worker:removed").map((p) => p.payload),
      [{ workerId: "w2" }, { workerId: "w1" }],
    );
  });
});
