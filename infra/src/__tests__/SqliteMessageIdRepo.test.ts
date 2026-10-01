import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SqliteMessageIdRepo } from "../persistence/SqliteMessageIdRepo.ts";
import { runMigrations } from "../persistence/MigrationRunner.ts";

const noopLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => noopLog };

let db: DatabaseSync;
let repo: SqliteMessageIdRepo;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  runMigrations(db, noopLog as never);
  repo = new SqliteMessageIdRepo(db);
});

describe("SqliteMessageIdRepo", () => {
  it("inbound ids ascend from 1; assistant ids number under the latest inbound", () => {
    assert.equal(repo.nextInbound("w1"), 1);
    assert.equal(repo.nextAssistant("w1"), "1.1");
    assert.equal(repo.nextAssistant("w1"), "1.2");
    assert.equal(repo.nextInbound("w1"), 2);
    assert.equal(repo.nextAssistant("w1"), "2.1");
  });

  it("an assistant block before any inbound message numbers under 0", () => {
    assert.equal(repo.nextAssistant("w1"), "0.1");
    assert.equal(repo.nextInbound("w1"), 1);
  });

  it("counters are per worker", () => {
    repo.nextInbound("w1");
    repo.nextInbound("w1");
    assert.equal(repo.nextInbound("w2"), 1);
  });

  it("survives a new repo instance on the same db (daemon restart)", () => {
    repo.nextInbound("w1");
    repo.nextAssistant("w1");
    const reopened = new SqliteMessageIdRepo(db);
    assert.equal(reopened.nextAssistant("w1"), "1.2");
    assert.equal(reopened.nextInbound("w1"), 2);
  });

  it("deleteByWorker drops only that worker's counter", () => {
    repo.nextInbound("w1");
    repo.nextInbound("w2");
    repo.deleteByWorker("w1");
    assert.equal(repo.nextInbound("w1"), 1);
    assert.equal(repo.nextInbound("w2"), 2);
  });
});
