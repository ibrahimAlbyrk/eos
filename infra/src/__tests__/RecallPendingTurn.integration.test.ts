// RecallPendingTurn against the REAL SqliteEventRepo — the regression guard for
// the wrong-message detection bug. The in-memory repo returns list({order:"desc"})
// as a newest-N window re-sorted ASC, so a list().find() picked the OLDEST
// user_message. These wire the actual use-case to the actual repo to prove
// latestOfType picks the newest end-to-end.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SqliteEventRepo } from "../persistence/SqliteEventRepo.ts";
import { runMigrations } from "../persistence/MigrationRunner.ts";
import { recallPendingTurn } from "../../../core/src/use-cases/RecallPendingTurn.ts";
import type { MessageQueueRepo } from "../../../core/src/ports/MessageQueueRepo.ts";
import type { TurnOutputTracker } from "../../../core/src/ports/TurnOutputTracker.ts";

const noopLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => noopLog };
const tracker = (seen: boolean): TurnOutputTracker => ({ reset: () => {}, markSeen: () => {}, seen: () => seen });
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
  it("recalls the 3rd (latest) of three user_messages, not the oldest in the desc window", () => {
    const id1 = repo.append("w1", 100, "user_message", userMsg("first", ["c0"]));
    repo.append("w1", 101, "state", { state: "WORKING" });
    const id2 = repo.append("w1", 102, "user_message", userMsg("second", ["c1"]));
    repo.append("w1", 103, "state", { state: "WORKING" });
    const id3 = repo.append("w1", 104, "user_message", userMsg("third", ["c2"]));
    repo.append("w1", 105, "state", { state: "WORKING" });

    const r = recallPendingTurn({ events: repo, queue: noopQueue, turnOutput: tracker(false) }, "w1");
    assert.deepEqual(r, { recalled: true, text: "third", clientMsgId: "c2", rowId: id3 });
    assert.ok(id1 < id2 && id2 < id3, "sanity: ids ascend with insertion");
  });

  it("finds the latest user_message past a >50-event window (SCAN_LIMIT is gone)", () => {
    repo.append("w1", 1, "user_message", userMsg("stale", ["c0"]));
    for (let i = 0; i < 60; i++) repo.append("w1", 2 + i, "state", { state: "WORKING" });
    const latest = repo.append("w1", 100, "user_message", userMsg("fresh", ["cN"]));

    const r = recallPendingTurn({ events: repo, queue: noopQueue, turnOutput: tracker(false) }, "w1");
    assert.deepEqual(r, { recalled: true, text: "fresh", clientMsgId: "cN", rowId: latest });
  });

  it("turnOutput seen ⇒ no recall (the agent heard the message)", () => {
    repo.append("w1", 100, "user_message", userMsg("hi", ["c1"]));
    const r = recallPendingTurn({ events: repo, queue: noopQueue, turnOutput: tracker(true) }, "w1");
    assert.deepEqual(r, { recalled: false });
  });
});
