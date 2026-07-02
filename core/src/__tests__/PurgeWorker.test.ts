import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { purgeWorker, type PurgeWorkerDeps } from "../use-cases/PurgeWorker.ts";
import { ConflictError, NotFoundError } from "../errors/index.ts";
import type { WorkerRow } from "../../../contracts/src/worker.ts";
import type { WorktreeRemovalEntry } from "../ports/WorktreeRemovalQueue.ts";

const NOW = 1_000_000;

interface Harness {
  deps: PurgeWorkerDeps;
  calls: string[];
  enqueued: WorktreeRemovalEntry[];
  publishes: Array<{ topic: string; payload: unknown }>;
}

function buildHarness(
  rowSpecs: Record<string, Partial<WorkerRow>>,
  children: Record<string, string[]> = {},
  opts: { withLeakDeps?: boolean } = { withLeakDeps: true },
): Harness {
  const calls: string[] = [];
  const enqueued: WorktreeRemovalEntry[] = [];
  const publishes: Array<{ topic: string; payload: unknown }> = [];
  const rows = new Map<string, WorkerRow>(
    Object.entries(rowSpecs).map(([id, p]) => [
      id,
      { id, state: "DONE", archived_at: 500, ...p } as WorkerRow,
    ]),
  );

  const deps = {
    workers: {
      findById: (id: string) => rows.get(id) ?? null,
      findChildrenIds: (id: string) => children[id] ?? [],
      delete: (id: string) => { calls.push(`workers.delete:${id}`); rows.delete(id); },
    },
    events: { deleteByWorker: (id: string) => { calls.push(`events.delete:${id}`); } },
    pending: { deleteByWorker: (id: string) => { calls.push(`pending.delete:${id}`); } },
    messageQueue: { deleteByWorker: (id: string) => { calls.push(`messageQueue.delete:${id}`); } },
    ...(opts.withLeakDeps
      ? {
          loops: { deleteByWorker: (id: string) => { calls.push(`loops.delete:${id}`); } },
          deleteConversation: (sessionId: string) => { calls.push(`conversation.delete:${sessionId}`); },
        }
      : {}),
    bus: {
      publish: (topic: string, payload: unknown) => {
        calls.push(`publish:${topic}`);
        publishes.push({ topic, payload });
      },
    },
    worktreeRemovals: { enqueue: (e: WorktreeRemovalEntry) => { enqueued.push(e); } },
    clock: { now: () => NOW },
    postKillCleanup: (id: string) => { calls.push(`postKillCleanup:${id}`); },
    killGracePeriodMs: 2000,
  } as unknown as PurgeWorkerDeps;

  return { deps, calls, enqueued, publishes };
}

describe("purgeWorker — guards", () => {
  it("rejects a non-archived worker with ConflictError before any side effect", () => {
    const h = buildHarness({ w1: { archived_at: null } });
    assert.throws(() => purgeWorker(h.deps, "w1"), ConflictError);
    assert.equal(h.calls.length, 0);
  });

  it("throws NotFoundError for an unknown id", () => {
    const h = buildHarness({});
    assert.throws(() => purgeWorker(h.deps, "ghost"), NotFoundError);
  });
});

describe("purgeWorker — cascade", () => {
  it("runs the full per-row cascade: enqueue with captured ref, row deletes, leak cleanups, worker:removed", () => {
    const h = buildHarness({
      w1: {
        worktree_from: "/repo",
        worktree_dir: "/repo/.eos/worktrees/eos-w1-x",
        branch: "eos-w1-x",
        session_id: "sess-1",
        name: "the-worker",
      },
    });
    const res = purgeWorker(h.deps, "w1");
    assert.deepEqual(res, { id: "w1", removed: true, name: "the-worker" });
    assert.deepEqual(h.enqueued, [
      { id: "w1", workerId: "w1", repoRoot: "/repo", worktreeDir: "/repo/.eos/worktrees/eos-w1-x", branch: "eos-w1-x", scheduledAt: NOW + 2000 },
    ]);
    for (const expected of [
      "workers.delete:w1",
      "events.delete:w1",
      "pending.delete:w1",
      "messageQueue.delete:w1",
      "loops.delete:w1",
      "conversation.delete:sess-1",
      "postKillCleanup:w1",
    ]) {
      assert.ok(h.calls.includes(expected), `missing ${expected}`);
    }
    assert.deepEqual(h.publishes, [{ topic: "worker:removed", payload: { workerId: "w1" } }]);
  });

  it("purges the whole subtree depth-first (children cascade before the parent)", () => {
    const h = buildHarness(
      { parent: { name: "p" }, child: {} },
      { parent: ["child"] },
    );
    const res = purgeWorker(h.deps, "parent");
    assert.deepEqual(res, { id: "parent", removed: true, name: "p" });
    assert.ok(h.calls.indexOf("workers.delete:child") < h.calls.indexOf("workers.delete:parent"));
    assert.deepEqual(
      h.publishes.map((p) => p.payload),
      [{ workerId: "child" }, { workerId: "parent" }],
    );
  });

  it("skips the worktree enqueue for a plain-cwd row (null branch/worktree_from)", () => {
    const h = buildHarness({ w1: { cwd: "/some/dir" } });
    purgeWorker(h.deps, "w1");
    assert.equal(h.enqueued.length, 0);
    assert.ok(h.calls.includes("workers.delete:w1"));
  });

  it("skips the conversation delete when session_id is null", () => {
    const h = buildHarness({ w1: {} });
    purgeWorker(h.deps, "w1");
    assert.ok(!h.calls.some((c) => c.startsWith("conversation.delete:")));
    assert.ok(h.calls.includes("loops.delete:w1"));
  });

  it("treats absent optional leak deps as a no-op (pre-feature/missing-pieces edge)", () => {
    const h = buildHarness({ w1: { session_id: "sess-1" } }, {}, { withLeakDeps: false });
    const res = purgeWorker(h.deps, "w1");
    assert.equal(res.removed, true);
    assert.ok(h.calls.includes("workers.delete:w1"));
    assert.ok(!h.calls.some((c) => c.startsWith("loops.delete:") || c.startsWith("conversation.delete:")));
  });
});
