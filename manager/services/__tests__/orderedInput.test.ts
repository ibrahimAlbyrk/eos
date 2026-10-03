import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { OrderedInput } from "../pty/orderedInput.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("OrderedInput", () => {
  it("writes a stream's chunks in seq order however they arrive", () => {
    const o = new OrderedInput();
    const out: string[] = [];
    const w = (d: string): void => { out.push(d); };
    o.accept("t1", 2, "b", w);
    o.accept("t1", 3, "c", w);
    assert.deepEqual(out, [], "held until seq 1 lands");
    o.accept("t1", 1, "a", w);
    o.accept("t1", 4, "d", w);
    assert.deepEqual(out, ["a", "b", "c", "d"]);
  });

  it("keeps streams apart", () => {
    const o = new OrderedInput();
    const out: string[] = [];
    o.accept("t1", 1, "x", (d) => out.push(d));
    o.accept("t2", 1, "y", (d) => out.push(d));
    assert.deepEqual(out, ["x", "y"]);
  });

  it("gives up waiting for a lost chunk after a while and still writes a straggler", async () => {
    const o = new OrderedInput();
    const out: string[] = [];
    const w = (d: string): void => { out.push(d); };
    o.accept("t1", 2, "b", w);
    o.accept("t1", 4, "d", w);
    await sleep(1100);
    assert.deepEqual(out, ["b", "d"]);
    o.accept("t1", 1, "a", w);
    o.accept("t1", 5, "e", w);
    assert.deepEqual(out, ["b", "d", "a", "e"]);
  });
});
