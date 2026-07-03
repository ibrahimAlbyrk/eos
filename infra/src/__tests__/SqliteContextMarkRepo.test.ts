import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SqliteContextMarkRepo } from "../persistence/SqliteContextMarkRepo.ts";
import { runMigrations } from "../persistence/MigrationRunner.ts";

const noopLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => noopLog };

let db: DatabaseSync;
let repo: SqliteContextMarkRepo;
const clock = { now: () => 1000 };

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  runMigrations(db, noopLog as never);
  repo = new SqliteContextMarkRepo(db, clock);
});

describe("SqliteContextMarkRepo", () => {
  it("first mark is true, a repeat is false (exactly-once latch)", () => {
    assert.equal(repo.mark("w1", "warn90"), true);
    assert.equal(repo.mark("w1", "warn90"), false);
    assert.equal(repo.mark("w1", "warn90"), false);
  });

  it("warn90 and full latch independently", () => {
    assert.equal(repo.mark("w1", "warn90"), true);
    assert.equal(repo.mark("w1", "full"), true);
    assert.equal(repo.mark("w1", "warn90"), false);
    assert.equal(repo.mark("w1", "full"), false);
  });

  it("marks are per-worker", () => {
    assert.equal(repo.mark("w1", "warn90"), true);
    assert.equal(repo.mark("w2", "warn90"), true);
  });

  it("has() reflects the current latch state", () => {
    assert.equal(repo.has("w1", "warn90"), false);
    repo.mark("w1", "warn90");
    assert.equal(repo.has("w1", "warn90"), true);
    assert.equal(repo.has("w1", "full"), false);
  });

  it("clear() re-arms every stage for a worker", () => {
    repo.mark("w1", "warn90");
    repo.mark("w1", "full");
    repo.clear("w1");
    assert.equal(repo.has("w1", "warn90"), false);
    assert.equal(repo.has("w1", "full"), false);
    // Cleared → mark can fire again (a fresh context epoch).
    assert.equal(repo.mark("w1", "warn90"), true);
    assert.equal(repo.mark("w1", "full"), true);
  });

  it("clear() is scoped to the worker", () => {
    repo.mark("w1", "warn90");
    repo.mark("w2", "warn90");
    repo.clear("w1");
    assert.equal(repo.has("w1", "warn90"), false);
    assert.equal(repo.has("w2", "warn90"), true);
  });

  it("a mark persists across repo instances (same db)", () => {
    repo.mark("w1", "full");
    const repo2 = new SqliteContextMarkRepo(db, clock);
    assert.equal(repo2.has("w1", "full"), true);
    assert.equal(repo2.mark("w1", "full"), false);
  });
});
