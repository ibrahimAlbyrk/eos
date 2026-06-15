import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SqliteWorktreeRemovalQueue } from "../persistence/SqliteWorktreeRemovalQueue.ts";
import { runMigrations } from "../persistence/MigrationRunner.ts";
import type { WorktreeRemovalEntry } from "../../../core/src/ports/WorktreeRemovalQueue.ts";

const noopLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => noopLog };

const entry = (over: Partial<WorktreeRemovalEntry> = {}): WorktreeRemovalEntry => ({
  id: "w1", workerId: "w1", repoRoot: "/repo", worktreeDir: "/repo/.eos/worktrees/eos-w1", branch: "eos-w1", scheduledAt: 1000, ...over,
});

let queue: SqliteWorktreeRemovalQueue;

beforeEach(() => {
  const db = new DatabaseSync(":memory:");
  runMigrations(db, noopLog as never);
  queue = new SqliteWorktreeRemovalQueue(db);
});

describe("SqliteWorktreeRemovalQueue", () => {
  it("round-trips an enqueued entry, preserving a null worktreeDir", () => {
    queue.enqueue(entry({ worktreeDir: null }));
    assert.deepEqual(queue.list(), [entry({ worktreeDir: null })]);
  });

  it("is idempotent on id — re-enqueue replaces, never duplicates", () => {
    queue.enqueue(entry({ scheduledAt: 1000 }));
    queue.enqueue(entry({ scheduledAt: 5000, branch: "eos-w1" }));
    const rows = queue.list();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].scheduledAt, 5000);
  });

  it("lists entries ordered by scheduledAt ascending", () => {
    queue.enqueue(entry({ id: "w-late", workerId: "w-late", scheduledAt: 3000 }));
    queue.enqueue(entry({ id: "w-early", workerId: "w-early", scheduledAt: 1000 }));
    assert.deepEqual(queue.list().map((e) => e.id), ["w-early", "w-late"]);
  });

  it("delete removes only the named entry", () => {
    queue.enqueue(entry({ id: "a", workerId: "a" }));
    queue.enqueue(entry({ id: "b", workerId: "b" }));
    queue.delete("a");
    assert.deepEqual(queue.list().map((e) => e.id), ["b"]);
  });
});
