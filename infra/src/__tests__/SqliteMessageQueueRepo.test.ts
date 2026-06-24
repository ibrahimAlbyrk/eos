import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SqliteMessageQueueRepo } from "../persistence/SqliteMessageQueueRepo.ts";
import { runMigrations } from "../persistence/MigrationRunner.ts";

const noopLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => noopLog };

let repo: SqliteMessageQueueRepo;

beforeEach(() => {
  const db = new DatabaseSync(":memory:");
  runMigrations(db, noopLog as never);
  repo = new SqliteMessageQueueRepo(db);
});

const pending = (clientMsgId: string | null, text = "msg") =>
  ({ workerId: "w1", clientMsgId, text, createdAt: 100, dispatchedAt: null });

describe("SqliteMessageQueueRepo", () => {
  it("inserts and lists pending in FIFO order", () => {
    repo.insert(pending("a", "one"));
    repo.insert(pending("b", "two"));
    const rows = repo.listPending("w1");
    assert.deepEqual(rows.map((r) => r.text), ["one", "two"]);
    assert.deepEqual(rows.map((r) => r.clientMsgId), ["a", "b"]);
  });

  it("duplicate (worker, clientMsgId) insert returns null — idempotency", () => {
    assert.notEqual(repo.insert(pending("a")), null);
    assert.equal(repo.insert(pending("a")), null);
    // same id on another worker is a different message
    assert.notEqual(repo.insert({ ...pending("a"), workerId: "w2" }), null);
  });

  it("dedup spans the ledger: a dispatched row still blocks its clientMsgId", () => {
    const id = repo.insert(pending("a"))!;
    repo.markDispatched([id], 200);
    assert.equal(repo.insert(pending("a")), null);
  });

  it("NULL clientMsgId rows never conflict (audit entries)", () => {
    assert.notEqual(repo.insert(pending(null)), null);
    assert.notEqual(repo.insert(pending(null)), null);
  });

  it("markDispatched moves rows out of pending", () => {
    const id = repo.insert(pending("a"))!;
    repo.markDispatched([id], 200);
    assert.equal(repo.listPending("w1").length, 0);
  });

  it("removePending deletes only pending rows", () => {
    const idPending = repo.insert(pending("a"))!;
    const idLedger = repo.insert({ ...pending("b"), dispatchedAt: 200 })!;
    assert.equal(repo.removePending("w1", idLedger), false);
    assert.equal(repo.removePending("w1", idPending), true);
    assert.equal(repo.removePending("w1", idPending), false);
  });

  it("clearPending wipes the queue but keeps the ledger", () => {
    repo.insert(pending("a"));
    repo.insert(pending("b"));
    repo.insert({ ...pending("sent"), dispatchedAt: 200 });
    assert.equal(repo.clearPending("w1"), 2);
    assert.equal(repo.listPending("w1").length, 0);
    // ledger row survives → its clientMsgId still dedups
    assert.equal(repo.insert(pending("sent")), null);
  });

  it("clearPendingUserPlane deletes only pending user-plane rows; agent-plane reports survive", () => {
    repo.insert(pending("user-steer", "stale steer")); // no plane → user
    repo.insert({
      ...pending(null, "[worker alice (w2)] reported:\nbody"),
      plane: "agent",
      envelope: { kind: "worker_report", fromWorker: "w2", workerName: "alice" },
      displayText: "body",
    });
    assert.equal(repo.clearPendingUserPlane("w1"), 1);
    // the agent-plane report survives and would drain on the next IDLE
    assert.deepEqual(repo.listPending("w1").map((r) => r.text), ["[worker alice (w2)] reported:\nbody"]);
    assert.equal(repo.listPendingUserPlane("w1").length, 0);
  });

  it("removeById deletes regardless of state (claim rollback)", () => {
    const id = repo.insert({ ...pending("a"), dispatchedAt: 200 })!;
    repo.removeById(id);
    assert.notEqual(repo.insert(pending("a")), null);
  });

  it("removeDispatchedByClientMsgId drops the dispatched ledger row (recall) and frees its id", () => {
    repo.insert({ ...pending("a"), dispatchedAt: 200 });
    repo.removeDispatchedByClientMsgId("w1", "a");
    // gone → its clientMsgId dedups no more
    assert.notEqual(repo.insert(pending("a")), null);
  });

  it("removeDispatchedByClientMsgId leaves a still-pending row (dispatched_at IS NULL) untouched", () => {
    repo.insert(pending("p")); // dispatched_at NULL
    repo.removeDispatchedByClientMsgId("w1", "p");
    assert.deepEqual(repo.listPending("w1").map((r) => r.clientMsgId), ["p"]);
    // and it scopes by worker — another worker's dispatched row with the same id survives
    repo.insert({ ...pending("p"), workerId: "w2", dispatchedAt: 200 });
    repo.removeDispatchedByClientMsgId("w1", "p");
    assert.equal(repo.insert({ ...pending("p"), workerId: "w2" }), null);
  });

  it("hasRecentDispatch matches only dispatched rows after sinceTs", () => {
    repo.insert({ ...pending(null, "selam"), dispatchedAt: 1000 });
    assert.equal(repo.hasRecentDispatch("w1", "selam", 500), true);
    assert.equal(repo.hasRecentDispatch("w1", "selam", 1000), false);
    assert.equal(repo.hasRecentDispatch("w1", "other", 500), false);
    repo.insert(pending("p", "queued-not-sent"));
    assert.equal(repo.hasRecentDispatch("w1", "queued-not-sent", 0), false);
  });

  it("deleteByWorker clears queue + ledger for that worker only", () => {
    repo.insert(pending("a"));
    repo.insert({ ...pending("b"), workerId: "w2" });
    repo.deleteByWorker("w1");
    assert.equal(repo.listPending("w1").length, 0);
    assert.equal(repo.listPending("w2").length, 1);
  });

  it("prune drops old ledger rows but never pending ones", () => {
    repo.insert({ ...pending("old"), dispatchedAt: 100 });
    repo.insert({ ...pending("new"), dispatchedAt: 900 });
    repo.insert(pending("still-pending"));
    repo.prune(500);
    assert.equal(repo.listPending("w1").length, 1);
    // "old" ledger row pruned → its clientMsgId is free again; "new" still blocks
    assert.notEqual(repo.insert(pending("old")), null);
    assert.equal(repo.insert(pending("new")), null);
  });

  it("round-trips an agent-plane envelope + displayText through the meta column", () => {
    repo.insert({
      ...pending(null, "[worker alice (w2)] reported:\nbody"),
      envelope: { kind: "worker_report", fromWorker: "w2", workerName: "alice" },
      displayText: "body",
    });
    const [row] = repo.listPending("w1");
    assert.deepEqual(row.envelope, { kind: "worker_report", fromWorker: "w2", workerName: "alice" });
    assert.equal(row.displayText, "body");
  });

  it("a plain message carries no envelope/displayText (NULL meta)", () => {
    repo.insert(pending("a", "hi"));
    const [row] = repo.listPending("w1");
    assert.equal(row.envelope, undefined);
    assert.equal(row.displayText, undefined);
  });

  it("listPendingUserPlane hides agent-plane rows; listPending still ships both (drain)", () => {
    repo.insert(pending("u1", "hello")); // no plane → defaults to user
    repo.insert({
      ...pending(null, "[worker alice (w2)] reported:\nbody"),
      plane: "agent",
      envelope: { kind: "worker_report", fromWorker: "w2", workerName: "alice" },
      displayText: "body",
    });
    // the drain sees everything FIFO…
    assert.deepEqual(repo.listPending("w1").map((r) => r.text), ["hello", "[worker alice (w2)] reported:\nbody"]);
    // …but the pill endpoint only sees the user's own message.
    assert.deepEqual(repo.listPendingUserPlane("w1").map((r) => r.text), ["hello"]);
  });

  it("a row queued without an explicit plane is user-plane (still renders as a pill)", () => {
    repo.insert(pending("a", "hi"));
    assert.deepEqual(repo.listPendingUserPlane("w1").map((r) => r.text), ["hi"]);
  });

  it("degrades gracefully on malformed meta (legacy/corrupt row) — never throws the drain", () => {
    const db = new DatabaseSync(":memory:");
    runMigrations(db, noopLog as never);
    db.prepare(
      "INSERT INTO queued_messages (worker_id, client_msg_id, text, created_at, dispatched_at, meta) VALUES ('w1', NULL, 'x', 1, NULL, 'not-json')",
    ).run();
    const [row] = new SqliteMessageQueueRepo(db).listPending("w1");
    assert.equal(row.text, "x");
    assert.equal(row.envelope, undefined);
    assert.equal(row.displayText, undefined);
  });
});
