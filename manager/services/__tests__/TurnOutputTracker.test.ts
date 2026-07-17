import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TurnOutputTrackerService } from "../TurnOutputTracker.ts";

describe("TurnOutputTrackerService", () => {
  it("unseen until markSeen, true after, re-reset clears it (per worker)", () => {
    const t = new TurnOutputTrackerService();
    assert.equal(t.seen("w1"), false, "no dispatch yet → not seen");
    t.reset("w1");
    assert.equal(t.seen("w1"), false, "fresh turn → not seen");
    t.markSeen("w1");
    assert.equal(t.seen("w1"), true, "first delta/message → seen");
    // A new dispatch (next turn) re-opens the recall window.
    t.reset("w1");
    assert.equal(t.seen("w1"), false);
  });

  it("recall row: null until attached, survives markSeen, cleared by reset", () => {
    const t = new TurnOutputTrackerService();
    assert.equal(t.recallRowId("w1"), null, "no dispatch yet → no target");
    t.reset("w1");
    assert.equal(t.recallRowId("w1"), null, "reset alone attaches nothing (agent-plane turn)");
    t.setRecallRow("w1", 42);
    assert.equal(t.recallRowId("w1"), 42, "user dispatch attached its row");
    t.markSeen("w1");
    assert.equal(t.recallRowId("w1"), 42, "output does not detach the row (seen gates recall)");
    t.reset("w1");
    assert.equal(t.recallRowId("w1"), null, "next turn clears the previous target");
  });

  it("setRecallRow without a prior reset still leaves seen false", () => {
    const t = new TurnOutputTrackerService();
    t.setRecallRow("w1", 7);
    assert.equal(t.recallRowId("w1"), 7);
    assert.equal(t.seen("w1"), false);
  });

  it("tracks workers independently", () => {
    const t = new TurnOutputTrackerService();
    t.reset("a"); t.reset("b");
    t.markSeen("a");
    t.setRecallRow("b", 9);
    assert.equal(t.seen("a"), true);
    assert.equal(t.seen("b"), false);
    assert.equal(t.recallRowId("a"), null);
    assert.equal(t.recallRowId("b"), 9);
  });
});
