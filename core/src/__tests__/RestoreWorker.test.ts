import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { restoreWorker, type RestoreWorkerDeps } from "../use-cases/RestoreWorker.ts";
import { ConflictError } from "../errors/index.ts";
import type { WorkerRow } from "../../../contracts/src/worker.ts";

interface Harness {
  deps: RestoreWorkerDeps;
  rows: Map<string, WorkerRow>;
  publishes: Array<{ topic: string; payload: unknown }>;
}

function buildHarness(
  rowSpecs: Record<string, Partial<WorkerRow>>,
  children: Record<string, string[]> = {},
): Harness {
  const publishes: Array<{ topic: string; payload: unknown }> = [];
  const rows = new Map<string, WorkerRow>(
    Object.entries(rowSpecs).map(([id, p]) => [id, { id, state: "DONE", ...p } as WorkerRow]),
  );

  // The deps carry NO supervisor / worktree / fs / clock port at all — restore
  // is a metadata flip by construction, so it succeeds when the tree is gone.
  const deps = {
    workers: {
      findById: (id: string) => rows.get(id) ?? null,
      findChildrenIds: (id: string) => children[id] ?? [],
      setArchived: (id: string, ts: number | null) => {
        const r = rows.get(id);
        if (r) r.archived_at = ts;
      },
    },
    bus: { publish: (topic: string, payload: unknown) => { publishes.push({ topic, payload }); } },
  } as unknown as RestoreWorkerDeps;

  return { deps, rows, publishes };
}

describe("restoreWorker", () => {
  it("clears archived_at over the whole subtree (children before parent) and publishes per row", () => {
    const h = buildHarness(
      { parent: { archived_at: 500 }, child: { archived_at: 500 } },
      { parent: ["child"] },
    );
    const res = restoreWorker(h.deps, "parent");
    assert.deepEqual(res, { id: "parent", restored: ["child", "parent"] });
    assert.equal(h.rows.get("parent")!.archived_at, null);
    assert.equal(h.rows.get("child")!.archived_at, null);
    assert.deepEqual(
      h.publishes,
      [
        { topic: "worker:change", payload: { workerId: "child", reason: "restored" } },
        { topic: "worker:change", payload: { workerId: "parent", reason: "restored" } },
      ],
    );
  });

  it("rejects a non-archived worker with ConflictError", () => {
    const h = buildHarness({ w1: {} });
    assert.throws(() => restoreWorker(h.deps, "w1"), ConflictError);
    assert.equal(h.publishes.length, 0);
  });

  it("rejects when any ancestor is archived — restore the topmost archived ancestor instead", () => {
    const h = buildHarness({
      grandparent: { archived_at: 400 },
      parent: { archived_at: 500, parent_id: "grandparent" },
      child: { archived_at: 500, parent_id: "parent" },
    });
    assert.throws(
      () => restoreWorker(h.deps, "child"),
      (e: unknown) =>
        e instanceof ConflictError && /topmost archived ancestor/.test((e as Error).message),
    );
    assert.equal(h.rows.get("child")!.archived_at, 500, "nothing may be cleared on rejection");
  });

  it("restores under a live parent, and tolerates a dangling parent_id (purged parent)", () => {
    const live = buildHarness({
      parent: {},
      child: { archived_at: 500, parent_id: "parent" },
    });
    assert.deepEqual(restoreWorker(live.deps, "child").restored, ["child"]);

    const orphan = buildHarness({ child: { archived_at: 500, parent_id: "ghost" } });
    assert.deepEqual(restoreWorker(orphan.deps, "child").restored, ["child"]);
    assert.equal(orphan.rows.get("child")!.archived_at, null);
  });
});
