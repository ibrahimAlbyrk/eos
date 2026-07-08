import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteScheduledPromptRepo } from "../persistence/SqliteScheduledPromptRepo.ts";
import { runMigrations } from "../persistence/MigrationRunner.ts";

const noopLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => noopLog };

function openMigrated(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  runMigrations(db, noopLog as never);
  return db;
}

let dir: string;
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sp-test-"));
  db = openMigrated(join(dir, "state.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("SqliteScheduledPromptRepo", () => {
  it("insert returns a pending row and findById round-trips it", () => {
    const repo = new SqliteScheduledPromptRepo(db);
    const row = repo.insert({ id: "sp-1", workerId: "orch-1", text: "hi", fireAt: 1000, createdAt: 500 });
    assert.deepEqual(row, {
      id: "sp-1", workerId: "orch-1", text: "hi", fireAt: 1000,
      status: "pending", createdAt: 500, firedAt: null, meta: null,
    });
    assert.deepEqual(repo.findById("sp-1"), row);
    assert.equal(repo.findById("missing"), null);
  });

  it("listByWorker returns that worker's rows fire_at-ordered; listDue filters to pending & past", () => {
    const repo = new SqliteScheduledPromptRepo(db);
    repo.insert({ id: "b", workerId: "orch-1", text: "b", fireAt: 3000, createdAt: 0 });
    repo.insert({ id: "a", workerId: "orch-1", text: "a", fireAt: 1000, createdAt: 0 });
    repo.insert({ id: "other", workerId: "orch-2", text: "o", fireAt: 1000, createdAt: 0 });

    assert.deepEqual(repo.listByWorker("orch-1").map((r) => r.id), ["a", "b"]);
    // now = 2000 → only 'a' (1000) is due; 'b' (3000) is future; 'other' is a
    // different worker but still due (listDue is not worker-scoped).
    assert.deepEqual(repo.listDue(2000).map((r) => r.id).sort(), ["a", "other"]);
  });

  it("markFired flips status, stamps firedAt + meta; listDue then excludes it", () => {
    const repo = new SqliteScheduledPromptRepo(db);
    repo.insert({ id: "sp-1", workerId: "orch-1", text: "hi", fireAt: 1000, createdAt: 0 });
    repo.markFired("sp-1", 1500, { late: true });
    const row = repo.findById("sp-1")!;
    assert.equal(row.status, "fired");
    assert.equal(row.firedAt, 1500);
    assert.deepEqual(row.meta, { late: true });
    assert.deepEqual(repo.listDue(9999), []);
  });

  it("cancel transitions ONLY a pending row and returns whether it did", () => {
    const repo = new SqliteScheduledPromptRepo(db);
    repo.insert({ id: "sp-1", workerId: "orch-1", text: "hi", fireAt: 1000, createdAt: 0 });
    assert.equal(repo.cancel("sp-1"), true);
    assert.equal(repo.findById("sp-1")!.status, "cancelled");
    // Re-cancelling a cancelled row, or an unknown id, is a no-op false.
    assert.equal(repo.cancel("sp-1"), false);
    assert.equal(repo.cancel("missing"), false);

    repo.insert({ id: "sp-2", workerId: "orch-1", text: "x", fireAt: 1000, createdAt: 0 });
    repo.markFired("sp-2", 1200, null);
    assert.equal(repo.cancel("sp-2"), false); // fired → not cancellable
    assert.equal(repo.findById("sp-2")!.status, "fired");
  });

  it("persists across a reopen (a second adapter sees the rows)", () => {
    const file = join(dir, "reopen.db");
    const db1 = openMigrated(file);
    new SqliteScheduledPromptRepo(db1).insert({ id: "sp-1", workerId: "orch-1", text: "hi", fireAt: 1000, createdAt: 0 });
    db1.close();

    const db2 = openMigrated(file);
    const row = new SqliteScheduledPromptRepo(db2).findById("sp-1");
    db2.close();
    assert.equal(row?.text, "hi");
  });
});
