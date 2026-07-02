import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { archiveWorker, type ArchiveWorkerDeps } from "../use-cases/ArchiveWorker.ts";
import { ConflictError } from "../errors/index.ts";
import type { WorkerRow } from "../../../contracts/src/worker.ts";

const NOW = 1_000_000;

interface Harness {
  deps: ArchiveWorkerDeps;
  calls: string[]; // flat ordered log across all fakes — order assertions read this
  rows: Map<string, WorkerRow>;
  publishes: Array<{ topic: string; payload: unknown }>;
  enqueued: unknown[];
}

function buildHarness(
  rowSpecs: Record<string, Partial<WorkerRow>>,
  children: Record<string, string[]> = {},
  supervised: Set<string> = new Set(),
): Harness {
  const calls: string[] = [];
  const publishes: Array<{ topic: string; payload: unknown }> = [];
  const enqueued: unknown[] = [];
  const rows = new Map<string, WorkerRow>(
    Object.entries(rowSpecs).map(([id, p]) => [id, { id, state: "IDLE", ...p } as WorkerRow]),
  );

  const deps = {
    workers: {
      findById: (id: string) => rows.get(id) ?? null,
      findChildrenIds: (id: string) => children[id] ?? [],
      setArchived: (id: string, ts: number | null) => {
        calls.push(`setArchived:${id}:${ts}`);
        const r = rows.get(id);
        if (r) r.archived_at = ts;
      },
      clearRuntime: (id: string) => {
        calls.push(`clearRuntime:${id}`);
        const r = rows.get(id);
        if (r) { r.pid = null; r.port = null; }
      },
      markDone: (id: string, endedAt: number) => {
        calls.push(`markDone:${id}:${endedAt}`);
        const r = rows.get(id);
        if (r) r.state = "DONE";
      },
    },
    pending: { deleteByWorker: (id: string) => { calls.push(`pending.delete:${id}`); } },
    bus: {
      publish: (topic: string, payload: unknown) => {
        calls.push(`publish:${topic}`);
        publishes.push({ topic, payload });
      },
    },
    clock: { now: () => NOW },
    supervisor: {
      has: (id: string) => supervised.has(id),
      escalateKill: (id: string) => { calls.push(`escalateKill:${id}`); },
      killPid: () => {},
    },
    findOrphanPids: () => [],
    stopBackendSession: (id: string) => { calls.push(`stopBackend:${id}`); },
    // Not deps of the use-case — present only to prove archive never reaches
    // for them (queued messages + the worktree queue survive archive).
    messageQueue: { deleteByWorker: (id: string) => { calls.push(`messageQueue.delete:${id}`); } },
    worktreeRemovals: { enqueue: (e: unknown) => { enqueued.push(e); calls.push("wt.enqueue"); } },
    killGracePeriodMs: 2000,
  } as unknown as ArchiveWorkerDeps;

  return { deps, calls, rows, publishes, enqueued };
}

describe("archiveWorker — process stop + settle", () => {
  it("escalates a supervised child through the supervisor, never the backend", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const h = buildHarness({ w1: { pid: 42 } }, {}, new Set(["w1"]));
      archiveWorker(h.deps, "w1");
      assert.ok(h.calls.includes("escalateKill:w1"));
      assert.ok(!h.calls.includes("stopBackend:w1"));
    } finally {
      mock.timers.reset();
    }
  });

  it("stops an unsupervised (in-process backend) worker via stopBackendSession", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const h = buildHarness({ w1: {} });
      archiveWorker(h.deps, "w1");
      assert.ok(h.calls.includes("stopBackend:w1"));
      assert.ok(!h.calls.includes("escalateKill:w1"));
    } finally {
      mock.timers.reset();
    }
  });

  it("stamps archived_at BEFORE the process stop and clears runtime after", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const h = buildHarness({ w1: { pid: 42 } }, {}, new Set(["w1"]));
      archiveWorker(h.deps, "w1");
      const stamp = h.calls.indexOf(`setArchived:w1:${NOW}`);
      const stop = h.calls.indexOf("escalateKill:w1");
      const clear = h.calls.indexOf("clearRuntime:w1");
      assert.ok(stamp >= 0 && stop >= 0 && clear >= 0);
      assert.ok(stamp < stop, "archived_at must be stamped before the stop (no archived-but-busy window)");
      assert.ok(stop < clear);
      assert.equal(h.rows.get("w1")!.pid, null);
    } finally {
      mock.timers.reset();
    }
  });

  it("settles a WORKING row to DONE and stamps it (invariant: archived ⇒ DONE/SUSPENDED)", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const h = buildHarness({ w1: { state: "WORKING" } });
      const res = archiveWorker(h.deps, "w1");
      assert.ok(h.calls.includes(`markDone:w1:${NOW}`));
      assert.equal(h.rows.get("w1")!.state, "DONE");
      assert.equal(h.rows.get("w1")!.archived_at, NOW);
      assert.equal(res.wasState, "WORKING");
    } finally {
      mock.timers.reset();
    }
  });

  it("archives a DONE row without a markDone rewrite; SUSPENDED likewise", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      for (const state of ["DONE", "SUSPENDED"] as const) {
        const h = buildHarness({ w1: { state } });
        archiveWorker(h.deps, "w1");
        assert.ok(!h.calls.some((c) => c.startsWith("markDone:")), `${state} must not be rewritten`);
        assert.equal(h.rows.get("w1")!.state, state);
        assert.equal(h.rows.get("w1")!.archived_at, NOW);
      }
    } finally {
      mock.timers.reset();
    }
  });
});

describe("archiveWorker — subtree + retained artifacts", () => {
  it("stamps the whole subtree depth-first (children before parent) and publishes per row", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const h = buildHarness({ parent: {}, child: {} }, { parent: ["child"] });
      const res = archiveWorker(h.deps, "parent");
      assert.deepEqual(res.archived, ["child", "parent"]);
      assert.deepEqual(
        h.publishes.map((p) => p.payload),
        [
          { workerId: "child", reason: "archived" },
          { workerId: "parent", reason: "archived" },
        ],
      );
      assert.ok(h.publishes.every((p) => p.topic === "worker:change"));
      assert.equal(h.rows.get("child")!.archived_at, NOW);
      assert.equal(h.rows.get("parent")!.archived_at, NOW);
    } finally {
      mock.timers.reset();
    }
  });

  it("deletes pending permission rows but never touches queued messages or the worktree queue, and never publishes worker:removed", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const h = buildHarness(
        { parent: { worktree_from: "/repo", branch: "eos-p" }, child: {} },
        { parent: ["child"] },
      );
      archiveWorker(h.deps, "parent");
      assert.ok(h.calls.includes("pending.delete:parent"));
      assert.ok(h.calls.includes("pending.delete:child"));
      assert.ok(!h.calls.some((c) => c.startsWith("messageQueue.delete:")));
      assert.equal(h.enqueued.length, 0, "archive must never enqueue worktree removal");
      assert.ok(h.publishes.every((p) => p.topic !== "worker:removed"));
    } finally {
      mock.timers.reset();
    }
  });

  it("rejects an already-archived worker with ConflictError", () => {
    const h = buildHarness({ w1: { archived_at: 123 } });
    assert.throws(() => archiveWorker(h.deps, "w1"), ConflictError);
    assert.equal(h.calls.length, 0, "guard must fire before any side effect");
  });
});
