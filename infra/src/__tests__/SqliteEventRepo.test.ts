import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SqliteEventRepo, PRUNE_CHECK_EVERY } from "../persistence/SqliteEventRepo.ts";
import { runMigrations } from "../persistence/MigrationRunner.ts";

const noopLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => noopLog };

let repo: SqliteEventRepo;

beforeEach(() => {
  const db = new DatabaseSync(":memory:");
  runMigrations(db, noopLog as never);
  repo = new SqliteEventRepo(db);
});

describe("SqliteEventRepo afterId delta", () => {
  it("returns only rows with id > cursor, in insertion order", () => {
    const id1 = repo.append("w1", 100, "jsonl", { kind: "thinking" });
    const id2 = repo.append("w1", 100, "jsonl", { kind: "assistant_text" });
    const id3 = repo.append("w1", 101, "jsonl", { kind: "tool_use" });
    const rows = repo.list({ workerId: "w1", since: 0, limit: 500, order: "desc", afterId: id1 });
    assert.deepEqual(rows.map((r) => r.id), [id2, id3]);
  });

  it("same-ms rows after the cursor are neither skipped nor duplicated", () => {
    const id1 = repo.append("w1", 100, "a", null);
    const id2 = repo.append("w1", 100, "b", null);
    const id3 = repo.append("w1", 100, "c", null);
    const rows = repo.list({ workerId: "w1", since: 0, limit: 500, order: "desc", afterId: id2 });
    assert.deepEqual(rows.map((r) => r.id), [id3]);
    assert.ok(id1 < id2);
  });

  it("afterId takes precedence over order/beforeId", () => {
    const id1 = repo.append("w1", 100, "a", null);
    const id2 = repo.append("w1", 200, "b", null);
    const rows = repo.list({ workerId: "w1", since: 0, limit: 500, order: "desc", beforeId: id2, afterId: id1 });
    assert.deepEqual(rows.map((r) => r.id), [id2]);
  });

  it("scopes to the worker and returns empty at the newest id", () => {
    repo.append("w2", 100, "a", null);
    const id = repo.append("w1", 100, "a", null);
    assert.deepEqual(repo.list({ workerId: "w1", since: 0, limit: 500, order: "desc", afterId: id }), []);
    const all = repo.list({ workerId: "w1", since: 0, limit: 500, order: "desc", afterId: 0 });
    assert.deepEqual(all.map((r) => r.id), [id]);
  });
});

describe("SqliteEventRepo retention", () => {
  const allIds = (workerId: string) =>
    repo.list({ workerId, since: 0, limit: 100000, order: "asc", afterId: 0 }).map((r) => r.id);

  it("pruneOlderThanRank keeps the newest N rows (by id), in order", () => {
    const ids: number[] = [];
    for (let i = 0; i < 10; i++) ids.push(repo.append("w1", 100 + i, "a", null));
    const removed = repo.pruneOlderThanRank("w1", 3);
    assert.equal(removed, 7);
    assert.deepEqual(allIds("w1"), ids.slice(-3)); // newest 3, ascending
  });

  it("pruneOlderThanRank is per-worker and a no-op when under the cap", () => {
    for (let i = 0; i < 5; i++) repo.append("w1", i, "a", null);
    for (let i = 0; i < 5; i++) repo.append("w2", i, "a", null);
    assert.equal(repo.pruneOlderThanRank("w1", 2), 3);
    assert.equal(allIds("w1").length, 2);
    assert.equal(allIds("w2").length, 5); // untouched
    assert.equal(repo.pruneOlderThanRank("w2", 10), 0); // fewer rows than cap → nothing
    assert.equal(allIds("w2").length, 5);
  });

  it("pruneAll bounds every worker to the newest N", () => {
    for (let i = 0; i < 6; i++) repo.append("w1", i, "a", null);
    for (let i = 0; i < 4; i++) repo.append("w2", i, "a", null);
    const removed = repo.pruneAll(2);
    assert.equal(removed, 4 + 2); // w1: 6→2 (-4), w2: 4→2 (-2)
    assert.equal(allIds("w1").length, 2);
    assert.equal(allIds("w2").length, 2);
  });

  it("append throttle bounds the table over many appends (newest kept)", () => {
    const db = new DatabaseSync(":memory:");
    runMigrations(db, noopLog as never);
    const MAX = 10;
    const bounded = new SqliteEventRepo(db, MAX);
    const total = 3 * PRUNE_CHECK_EVERY + 7;
    let lastId = 0;
    for (let i = 0; i < total; i++) lastId = bounded.append("w1", i, "a", null);
    const rows = bounded.list({ workerId: "w1", since: 0, limit: 100000, order: "asc", afterId: 0 });
    // Steady state: oscillates between MAX and MAX+PRUNE_CHECK_EVERY (the prune
    // runs only every PRUNE_CHECK_EVERY appends), never near `total`.
    assert.ok(rows.length <= MAX + PRUNE_CHECK_EVERY, `expected bounded table, got ${rows.length}`);
    assert.ok(rows.length < total);
    assert.equal(rows[rows.length - 1].id, lastId); // newest row survives
  });

  it("maxPerWorker <= 0 disables pruning", () => {
    const db = new DatabaseSync(":memory:");
    runMigrations(db, noopLog as never);
    const unbounded = new SqliteEventRepo(db, 0);
    assert.equal(unbounded.pruneAll(0), 0);
    for (let i = 0; i < 5; i++) unbounded.append("w1", i, "a", null);
    assert.equal(unbounded.pruneOlderThanRank("w1", 2), 3); // explicit call still works
  });
});
