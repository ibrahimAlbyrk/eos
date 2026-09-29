import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { coalesceStream } from "../gateway.ts";

function sink() {
  const writes: string[] = [];
  let ended = false;
  return {
    writes,
    get ended() { return ended; },
    write(c: Buffer) { writes.push(c.toString()); return true; },
    end() { ended = true; },
    once() { return undefined; },
  };
}

describe("coalesceStream", () => {
  it("sends the first write after a quiet spell at once", () => {
    const src = new PassThrough();
    const dst = sink();
    coalesceStream(src, dst, 20);
    src.write("first");
    assert.deepEqual(dst.writes, ["first"], "no waiting on the leading edge");
    src.end();
  });

  it("folds a burst into few writes without losing or reordering bytes", async () => {
    const src = new PassThrough();
    const dst = sink();
    coalesceStream(src, dst, 10);
    const parts = Array.from({ length: 200 }, (_, i) => `e${i};`);
    for (const p of parts) src.write(p);
    src.end();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(dst.writes.join(""), parts.join(""));
    assert.ok(dst.writes.length <= 3, `expected a folded burst, got ${dst.writes.length} writes`);
    assert.ok(dst.ended);
  });
});
