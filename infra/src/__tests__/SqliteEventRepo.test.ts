import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SqliteEventRepo } from "../persistence/SqliteEventRepo.ts";
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
