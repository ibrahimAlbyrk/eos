import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { DeltaOffsets } from "../delta-offsets.ts";

describe("DeltaOffsets", () => {
  it("numbers each delta by where it starts in its block", () => {
    const o = new DeltaOffsets();
    assert.equal(o.next("w", "b", "start", 3), 0);
    assert.equal(o.next("w", "b", "append", 2), 3);
    assert.equal(o.next("w", "c", "start", 4), 0, "blocks count apart");
    assert.equal(o.next("w", "b", "append", 1), 5);
    assert.equal(o.next("w", "b", "stop", 0), 6);
    assert.equal(o.next("w", "b", "append", 1), 0, "a stopped block is forgotten");
  });

  it("a new start restarts the block", () => {
    const o = new DeltaOffsets();
    o.next("w", "b", "start", 5);
    assert.equal(o.next("w", "b", "start", 2), 0);
    assert.equal(o.next("w", "b", "append", 1), 2);
  });
});
