import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SqliteLoopStateRepo } from "../persistence/SqliteLoopStateRepo.ts";
import { runMigrations } from "../persistence/MigrationRunner.ts";
import type { InsertLoopInput } from "../../../core/src/ports/LoopStateRepo.ts";
import type { GoalSpec } from "../../../contracts/src/loop.ts";

const noopLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => noopLog };

const GOAL: GoalSpec = { summary: "done", criteria: [{ id: "c1", text: "passes", verify: "npm test" }] };

function input(id: string, workerId: string, over: Partial<InsertLoopInput> = {}): InsertLoopInput {
  return {
    id, workerId, parentId: null, goal: GOAL, strategy: "hybrid",
    maxAttempts: null, startedAt: 1000, updatedAt: 1000, ...over,
  };
}

let db: DatabaseSync;
let repo: SqliteLoopStateRepo;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  runMigrations(db, noopLog as never);
  repo = new SqliteLoopStateRepo(db);
});

describe("migration 047_worker_loops", () => {
  it("applies cleanly and creates the worker_loops table", () => {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'worker_loops'")
      .get() as { name: string } | undefined;
    assert.equal(row?.name, "worker_loops");
  });
});

describe("SqliteLoopStateRepo round-trip", () => {
  it("insert → findActiveByWorker returns the mapped row; setStatus moves it out of active", () => {
    repo.insert(input("l-1", "w-1", { parentId: "o-1", maxAttempts: 3 }));

    const found = repo.findActiveByWorker("w-1");
    assert.ok(found);
    assert.equal(found.id, "l-1");
    assert.equal(found.workerId, "w-1");
    assert.equal(found.parentId, "o-1");
    assert.equal(found.status, "active");
    assert.equal(found.attempt, 0);
    assert.equal(found.maxAttempts, 3);
    assert.equal(found.strategy, "hybrid");
    assert.deepEqual(found.goal, GOAL);
    assert.deepEqual(found.progressRing, []);

    repo.setStatus("l-1", "passed");
    assert.equal(repo.findActiveByWorker("w-1"), null);
    assert.equal(repo.findById("l-1")?.status, "passed");
  });

  it("the partial unique index allows only one active loop per worker", () => {
    repo.insert(input("l-1", "w-1"));
    assert.throws(() => repo.insert(input("l-2", "w-1")), /UNIQUE|constraint/i);
    // A second loop is allowed once the first leaves the active state.
    repo.setStatus("l-1", "stopped");
    repo.insert(input("l-2", "w-1"));
    assert.equal(repo.findActiveByWorker("w-1")?.id, "l-2");
  });

  it("listActive returns every active loop, oldest first", () => {
    repo.insert(input("l-a", "w-a", { startedAt: 100 }));
    repo.insert(input("l-b", "w-b", { startedAt: 200 }));
    repo.setStatus("l-b", "stopped");
    assert.deepEqual(repo.listActive().map((l) => l.id), ["l-a"]);
  });

  it("recordAttempt increments the counter and appends to the progress ring", () => {
    repo.insert(input("l-1", "w-1"));
    repo.recordAttempt("l-1", { stateHash: "s1", outcomeHash: "o1", reason: "still red" });
    repo.recordAttempt("l-1", { stateHash: "s2", outcomeHash: "o2", reason: "still red" });
    const row = repo.findById("l-1");
    assert.equal(row?.attempt, 2);
    assert.equal(row?.lastReason, "still red");
    assert.deepEqual(row?.progressRing.map((a) => a.stateHash), ["s1", "s2"]);
  });

  it("awaiting_input defaults to false and round-trips through setAwaitingInput", () => {
    repo.insert(input("l-1", "w-1"));
    assert.equal(repo.findById("l-1")?.awaitingInput, false);
    repo.setAwaitingInput("l-1", true);
    assert.equal(repo.findById("l-1")?.awaitingInput, true);
    repo.setAwaitingInput("l-1", false);
    assert.equal(repo.findById("l-1")?.awaitingInput, false);
  });

  it("setHeldReport stores and clears the held report; clear removes the row", () => {
    repo.insert(input("l-1", "w-1"));
    repo.setHeldReport("l-1", "result: held");
    assert.equal(repo.findById("l-1")?.heldReport, "result: held");
    repo.setHeldReport("l-1", null);
    assert.equal(repo.findById("l-1")?.heldReport, null);
    repo.clear("l-1");
    assert.equal(repo.findById("l-1"), null);
  });

  it("held_output defaults to null and round-trips the structured payload (typed object + status)", () => {
    repo.insert(input("l-1", "w-1"));
    assert.equal(repo.findById("l-1")?.heldOutput, null);
    const payload = { output: { files: ["a.ts"], count: 1 }, status: "done" as const };
    repo.setHeldOutput("l-1", payload);
    assert.deepEqual(repo.findById("l-1")?.heldOutput, payload);
  });

  it("setHeldReport(null) clears held_output too (shared lifecycle)", () => {
    repo.insert(input("l-1", "w-1"));
    repo.setHeldReport("l-1", "failed: broke");
    repo.setHeldOutput("l-1", { output: { e: 1 }, status: "failed", reason: "broke" });
    assert.ok(repo.findById("l-1")?.heldOutput);
    // Clearing the report clears its structured twin atomically.
    repo.setHeldReport("l-1", null);
    assert.equal(repo.findById("l-1")?.heldReport, null);
    assert.equal(repo.findById("l-1")?.heldOutput, null);
  });

  it("amend replaces only the provided goal/strategy/maxAttempts and keeps the rest", () => {
    repo.insert(input("l-1", "w-1", { maxAttempts: 5 }));
    const NEW_GOAL: GoalSpec = { summary: "v2", criteria: [{ id: "c2", text: "boots", verify: "curl -sf localhost" }] };
    repo.amend("l-1", { goal: NEW_GOAL, strategy: "judge" });
    const row = repo.findById("l-1");
    assert.deepEqual(row?.goal, NEW_GOAL);
    assert.equal(row?.strategy, "judge");
    assert.equal(row?.maxAttempts, 5); // absent in the patch → untouched
  });

  it("amend sets max_attempts to null (unbounded) when the key is present", () => {
    repo.insert(input("l-1", "w-1", { maxAttempts: 5 }));
    repo.amend("l-1", { maxAttempts: null });
    assert.equal(repo.findById("l-1")?.maxAttempts, null);
  });

  it("check_failures defaults to 0 and round-trips through setCheckFailures (Fix 6c)", () => {
    repo.insert(input("l-1", "w-1"));
    assert.equal(repo.findById("l-1")?.checkFailures, 0);
    repo.setCheckFailures("l-1", 1);
    assert.equal(repo.findById("l-1")?.checkFailures, 1);
    repo.setCheckFailures("l-1", 0);
    assert.equal(repo.findById("l-1")?.checkFailures, 0);
  });

  it("deleteByWorker removes every loop row for the worker (any status) and leaves others", () => {
    repo.insert(input("l-1", "w-1"));
    repo.setStatus("l-1", "passed");
    repo.insert(input("l-2", "w-1"));
    repo.insert(input("l-3", "w-2"));
    repo.deleteByWorker("w-1");
    assert.equal(repo.findById("l-1"), null);
    assert.equal(repo.findById("l-2"), null);
    assert.equal(repo.findById("l-3")?.workerId, "w-2");
  });

  it("deleteByWorker on a worker with no loop rows is a no-op", () => {
    repo.insert(input("l-1", "w-1"));
    repo.deleteByWorker("w-none");
    assert.equal(repo.findById("l-1")?.id, "l-1");
  });

  it("resetProgress clears the ring but leaves the attempt counter", () => {
    repo.insert(input("l-1", "w-1"));
    repo.recordAttempt("l-1", { stateHash: "s1", outcomeHash: "o1", reason: "red" });
    repo.recordAttempt("l-1", { stateHash: "s2", outcomeHash: "o2", reason: "red" });
    assert.equal(repo.findById("l-1")?.attempt, 2);
    repo.resetProgress("l-1");
    const row = repo.findById("l-1");
    assert.deepEqual(row?.progressRing, []);
    assert.equal(row?.attempt, 2); // the attempt bound is orthogonal to the ring
  });
});
