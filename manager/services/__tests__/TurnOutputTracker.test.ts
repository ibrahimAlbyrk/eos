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

  it("tracks workers independently", () => {
    const t = new TurnOutputTrackerService();
    t.reset("a"); t.reset("b");
    t.markSeen("a");
    assert.equal(t.seen("a"), true);
    assert.equal(t.seen("b"), false);
  });
});
