// RecallPendingTurn against the REAL SqliteEventRepo — the regression guard for
// the wrong-message recall bug: recall must resolve the exact row id the
// dispatch attached (findById), never a "latest user_message" scan that an
// agent-plane-started turn could point at an older, answered message.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SqliteEventRepo } from "../persistence/SqliteEventRepo.ts";
import { runMigrations } from "../persistence/MigrationRunner.ts";
import { recallPendingTurn } from "../../../core/src/use-cases/RecallPendingTurn.ts";
import type { MessageQueueRepo } from "../../../core/src/ports/MessageQueueRepo.ts";
import type { TurnOutputTracker } from "../../../core/src/ports/TurnOutputTracker.ts";

const noopLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => noopLog };
const tracker = (seen: boolean, rowId: number | null): TurnOutputTracker => {
  const state = { seen, rowId };
  return {
    reset: () => { state.seen = false; state.rowId = null; },
    setRecallRow: (_w, id) => { state.rowId = id; },
    markSeen: () => { state.seen = true; },
    seen: () => state.seen,
    recallRowId: () => state.rowId,
  };
};
// The recall path only touches removeDispatchedByClientMsgId; the ledger-drop is
// covered by the core unit tests, so a no-op queue is enough here.
const noopQueue = { removeDispatchedByClientMsgId: () => {} } as unknown as MessageQueueRepo;
const userMsg = (text: string, clientMsgIds: string[]) => ({ text, clientMsgIds });

let repo: SqliteEventRepo;

beforeEach(() => {
  const db = new DatabaseSync(":memory:");
  runMigrations(db, noopLog as never);
  repo = new SqliteEventRepo(db);
});

describe("recallPendingTurn against the real SqliteEventRepo", () => {
  it("recalls exactly the tracked row among three user_messages", () => {
    repo.append("w1", 100, "user_message", userMsg("first", ["c0"]));
    repo.append("w1", 101, "state", { state: "WORKING" });
    repo.append("w1", 102, "user_message", userMsg("second", ["c1"]));
    const id3 = repo.append("w1", 104, "user_message", userMsg("third", ["c2"]));
    repo.append("w1", 105, "state", { state: "WORKING" });

    const r = recallPendingTurn({ events: repo, queue: noopQueue, turnOutput: tracker(false, id3) }, "w1");
    assert.deepEqual(r, { recalled: true, text: "third", clientMsgId: "c2", rowId: id3 });
  });

  // The bug's shape end-to-end: answered user_messages exist, but the current
  // turn was agent-plane-started (no recall target) → nothing is recalled.
  it("no recall target ⇒ no recall even with answered user_messages in the log", () => {
    repo.append("w1", 100, "user_message", userMsg("answered", ["c0"]));
    repo.append("w1", 101, "orchestrator_message", { text: "directive", fromParent: "o1" });

    const r = recallPendingTurn({ events: repo, queue: noopQueue, turnOutput: tracker(false, null) }, "w1");
    assert.deepEqual(r, { recalled: false });
  });

  it("turnOutput seen ⇒ no recall (the agent heard the message)", () => {
    const id = repo.append("w1", 100, "user_message", userMsg("hi", ["c1"]));
    const r = recallPendingTurn({ events: repo, queue: noopQueue, turnOutput: tracker(true, id) }, "w1");
    assert.deepEqual(r, { recalled: false });
  });

  it("tracked row deleted (prune/kill) ⇒ no recall", () => {
    const id = repo.append("w1", 100, "user_message", userMsg("gone", ["c1"]));
    repo.deleteByWorker("w1");
    const r = recallPendingTurn({ events: repo, queue: noopQueue, turnOutput: tracker(false, id) }, "w1");
    assert.deepEqual(r, { recalled: false });
  });

  it("findById is worker-scoped — a stale id never addresses another worker's row", () => {
    const id = repo.append("w1", 100, "user_message", userMsg("mine", ["c1"]));
    assert.equal(repo.findById("w2", id), null);
    assert.equal(repo.findById("w1", id)?.id, id);
  });
});
