import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeContextPct } from "../domain/context-usage.ts";

describe("computeContextPct", () => {
  it("returns null when the limit is unknown or non-positive", () => {
    assert.equal(computeContextPct(1000, null), null);
    assert.equal(computeContextPct(1000, 0), null);
    assert.equal(computeContextPct(1000, -5), null);
  });

  it("computes the rounded percentage of the window in use", () => {
    assert.equal(computeContextPct(0, 200_000), 0);
    assert.equal(computeContextPct(100_000, 200_000), 50);
    assert.equal(computeContextPct(150_000, 1_000_000), 15);
  });

  it("rounds to the nearest whole percent", () => {
    assert.equal(computeContextPct(2_995, 200_000), 1); // 1.4975 → 1
    assert.equal(computeContextPct(3_010, 200_000), 2); // 1.505 → 2
  });

  it("clamps at 100 when used exceeds the limit", () => {
    assert.equal(computeContextPct(200_000, 200_000), 100);
    assert.equal(computeContextPct(250_000, 200_000), 100);
  });
});
