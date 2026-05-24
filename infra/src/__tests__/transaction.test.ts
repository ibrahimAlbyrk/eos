import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { withTransaction } from "../persistence/transaction.ts";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT)");
});

describe("withTransaction", () => {
  it("commits on success", () => {
    withTransaction(db, () => {
      db.exec("INSERT INTO kv VALUES ('a', '1')");
    });
    const row = db.prepare("SELECT v FROM kv WHERE k = 'a'").get() as { v: string } | undefined;
    assert.equal(row?.v, "1");
  });

  it("rolls back when fn throws", () => {
    assert.throws(() => {
      withTransaction(db, () => {
        db.exec("INSERT INTO kv VALUES ('b', '2')");
        throw new Error("boom");
      });
    }, /boom/);
    const row = db.prepare("SELECT v FROM kv WHERE k = 'b'").get() as { v: string } | undefined;
    assert.equal(row, undefined);
  });

  it("forwards return value from fn", () => {
    const result = withTransaction(db, () => {
      db.exec("INSERT INTO kv VALUES ('c', '3')");
      return 42;
    });
    assert.equal(result, 42);
  });
});
