import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectNoProgress, outcomeKey, type ProgressEntry } from "../domain/loop-progress.ts";

const e = (stateHash: string, unmetCount: number, outcomeHash = "o"): ProgressEntry => ({ stateHash, outcomeHash, unmetCount });

describe("outcomeKey", () => {
  it("is order-independent", () => {
    assert.equal(outcomeKey(["b", "a", "c"]), outcomeKey(["c", "b", "a"]));
    assert.equal(outcomeKey(["a", "b"]), "a|b");
  });
});

describe("detectNoProgress", () => {
  it("returns null until a full window has accumulated", () => {
    assert.equal(detectNoProgress([e("h", 1), e("h", 1)], 3), null);
  });

  it("FROZEN: identical change-set across the window, not shrinking", () => {
    assert.equal(detectNoProgress([e("h", 1), e("h", 1), e("h", 1)], 3), "frozen");
  });

  it("OSCILLATION: cycling between ≤2 change-sets, not shrinking", () => {
    assert.equal(detectNoProgress([e("a", 1), e("b", 1), e("a", 1)], 3), "oscillation");
  });

  it("shrinking unmet across the window → null (real convergence)", () => {
    assert.equal(detectNoProgress([e("h", 3), e("h", 2), e("h", 1)], 3), null);
    assert.equal(detectNoProgress([e("a", 2), e("b", 2), e("a", 1)], 3), null);
  });

  it("a distinct change-set each attempt with DIFFERENT unmet sets → null (still exploring)", () => {
    assert.equal(detectNoProgress([e("a", 1, "x"), e("b", 1, "y"), e("c", 1, "x")], 3), null);
  });

  it("only the last `window` entries are considered", () => {
    // older shrinking entries don't rescue a frozen tail
    assert.equal(detectNoProgress([e("x", 9), e("h", 1), e("h", 1), e("h", 1)], 3), "frozen");
  });
});

describe("detectNoProgress — stalled (thrasher)", () => {
  it("STALLED: a new change-set every attempt, identical unmet set, not shrinking", () => {
    assert.equal(detectNoProgress([e("a", 1), e("b", 1), e("c", 1)], 3), "stalled");
  });

  it("identical unmet set but a shrinking count → null (convergence guard fires first)", () => {
    assert.equal(detectNoProgress([e("a", 2), e("b", 2), e("c", 1)], 3), null);
  });

  it("frozen and oscillation take precedence over stalled", () => {
    assert.equal(detectNoProgress([e("h", 1), e("h", 1), e("h", 1)], 3), "frozen");
    assert.equal(detectNoProgress([e("a", 1), e("b", 1), e("a", 1)], 3), "oscillation");
  });

  it("needs a full window before flagging", () => {
    assert.equal(detectNoProgress([e("a", 1), e("b", 1)], 3), null);
  });
});
