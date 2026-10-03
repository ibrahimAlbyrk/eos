import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { TurnSettleService } from "../TurnSettleService.ts";

function make(): { s: TurnSettleService; advance: (ms: number) => void } {
  let now = 1000;
  const s = new TurnSettleService({ now: () => now }, 4000);
  return { s, advance: (ms) => { now += ms; } };
}

describe("TurnSettleService — interrupt pending", () => {
  it("an interrupt is pending until the stream ends the interrupted turn", () => {
    const { s } = make();
    s.markInterrupt("w1");
    assert.equal(s.isSettling("w1"), true);
    assert.equal(s.isInterruptPending("w1"), true);
    s.mark("w1");
    assert.equal(s.isSettling("w1"), true);
    assert.equal(s.isInterruptPending("w1"), false);
  });

  it("lapses with the settle window", () => {
    const { s, advance } = make();
    s.markInterrupt("w1");
    advance(4001);
    assert.equal(s.isInterruptPending("w1"), false);
    assert.equal(s.isSettling("w1"), false);
  });

  it("clear drops it", () => {
    const { s } = make();
    s.markInterrupt("w1");
    s.clear("w1");
    assert.equal(s.isInterruptPending("w1"), false);
  });

  it("a plain turn end is never an interrupt", () => {
    const { s } = make();
    s.mark("w1");
    assert.equal(s.isInterruptPending("w1"), false);
  });
});
