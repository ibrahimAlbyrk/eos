import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  purgeExpiredArchives,
  purgeAllArchived,
  RETENTION_PERIOD_MS,
  type ArchiveRetention,
  type PurgeExpiredArchivesDeps,
} from "../use-cases/PurgeExpiredArchives.ts";
import type { WorkerRow } from "../../../contracts/src/worker.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY_MS;

interface Harness {
  deps: PurgeExpiredArchivesDeps;
  rows: Map<string, WorkerRow>;
  warns: string[];
}

// Rows carry parent_id + archived_at; children are derived from parent_id so
// the root scan and the purge recursion see one consistent tree.
function buildHarness(rowSpecs: Record<string, Partial<WorkerRow>>): Harness {
  const rows = new Map<string, WorkerRow>(
    Object.entries(rowSpecs).map(([id, p]) => [
      id,
      { id, state: "DONE", parent_id: null, archived_at: null, ...p } as WorkerRow,
    ]),
  );
  const warns: string[] = [];
  const deps = {
    workers: {
      findById: (id: string) => rows.get(id) ?? null,
      findChildrenIds: (id: string) =>
        [...rows.values()].filter((r) => r.parent_id === id).map((r) => r.id),
      delete: (id: string) => { rows.delete(id); },
      listArchived: () => [...rows.values()].filter((r) => r.archived_at != null),
    },
    events: { deleteByWorker: () => {} },
    pending: { deleteByWorker: () => {} },
    messageQueue: { deleteByWorker: () => {} },
    loops: { deleteByWorker: () => {} },
    deleteConversation: () => {},
    bus: { publish: () => {} },
    worktreeRemovals: { enqueue: () => {} },
    clock: { now: () => NOW },
    log: { warn: (msg: string) => { warns.push(msg); } },
  } as unknown as PurgeExpiredArchivesDeps;
  return { deps, rows, warns };
}

describe("purgeExpiredArchives — retention gate", () => {
  it('"off" never purges, however old the archive', () => {
    const h = buildHarness({ old: { archived_at: NOW - 365 * DAY_MS } });
    assert.deepEqual(purgeExpiredArchives(h.deps, "off"), []);
    assert.ok(h.rows.has("old"));
  });

  for (const [retention, periodMs] of Object.entries(RETENTION_PERIOD_MS) as Array<
    [Exclude<ArchiveRetention, "off">, number]
  >) {
    it(`${retention}: purges at exactly the threshold, keeps one ms younger`, () => {
      const h = buildHarness({
        "at-threshold": { archived_at: NOW - periodMs },
        younger: { archived_at: NOW - periodMs + 1 },
      });
      assert.deepEqual(purgeExpiredArchives(h.deps, retention), ["at-threshold"]);
      assert.ok(!h.rows.has("at-threshold"));
      assert.ok(h.rows.has("younger"));
    });
  }

  it("never touches active (non-archived) rows", () => {
    const h = buildHarness({
      live: { state: "WORKING" },
      idle: { state: "IDLE" },
      expired: { archived_at: NOW - 31 * DAY_MS },
    });
    assert.deepEqual(purgeExpiredArchives(h.deps, "monthly"), ["expired"]);
    assert.ok(h.rows.has("live"));
    assert.ok(h.rows.has("idle"));
  });
});

describe("purgeExpiredArchives — subtree roots", () => {
  it("iterates roots only: an archived child purges via its root's cascade, exactly once", () => {
    const h = buildHarness({
      root: { archived_at: NOW - 2 * DAY_MS },
      child: { parent_id: "root", archived_at: NOW - 2 * DAY_MS },
    });
    assert.deepEqual(purgeExpiredArchives(h.deps, "daily"), ["root"]);
    assert.ok(!h.rows.has("root"));
    assert.ok(!h.rows.has("child"));
    assert.deepEqual(h.warns, [], "child must not be re-purged as its own root");
  });

  it("an archived child under a LIVE parent is a root of its own archived subtree", () => {
    const h = buildHarness({
      parent: { state: "IDLE" },
      "arch-child": { parent_id: "parent", archived_at: NOW - 8 * DAY_MS },
    });
    assert.deepEqual(purgeExpiredArchives(h.deps, "weekly"), ["arch-child"]);
    assert.ok(h.rows.has("parent"));
  });

  it("an archived row whose parent is gone (already purged/killed) counts as a root", () => {
    const h = buildHarness({
      orphan: { parent_id: "ghost", archived_at: NOW - 2 * DAY_MS },
    });
    assert.deepEqual(purgeExpiredArchives(h.deps, "daily"), ["orphan"]);
  });

  it("root age governs the unit: a young root keeps its old archived child", () => {
    const h = buildHarness({
      root: { archived_at: NOW - 1 },
      child: { parent_id: "root", archived_at: NOW - 40 * DAY_MS },
    });
    assert.deepEqual(purgeExpiredArchives(h.deps, "monthly"), []);
    assert.ok(h.rows.has("root"));
    assert.ok(h.rows.has("child"));
  });

  it("one failing root is logged and skipped; the rest still purge", () => {
    const h = buildHarness({
      bad: { archived_at: NOW - 2 * DAY_MS },
      good: { archived_at: NOW - 2 * DAY_MS },
    });
    const realDelete = h.deps.workers.delete.bind(h.deps.workers);
    h.deps.workers.delete = (id: string) => {
      if (id === "bad") throw new Error("boom");
      realDelete(id);
    };
    assert.deepEqual(purgeExpiredArchives(h.deps, "daily"), ["good"]);
    assert.equal(h.warns.length, 1);
    assert.ok(!h.rows.has("good"));
  });
});

describe("purgeAllArchived — app-close path", () => {
  it("purges every archived root regardless of age, leaves active rows", () => {
    const h = buildHarness({
      live: { state: "WORKING" },
      fresh: { archived_at: NOW - 1 },
      old: { archived_at: NOW - 90 * DAY_MS },
      child: { parent_id: "old", archived_at: NOW - 90 * DAY_MS },
    });
    assert.deepEqual(purgeAllArchived(h.deps).sort(), ["fresh", "old"]);
    assert.deepEqual([...h.rows.keys()], ["live"]);
  });

  it("is idempotent: a second call finds nothing and returns []", () => {
    const h = buildHarness({ a: { archived_at: NOW - 1 } });
    assert.deepEqual(purgeAllArchived(h.deps), ["a"]);
    assert.deepEqual(purgeAllArchived(h.deps), []);
  });
});
