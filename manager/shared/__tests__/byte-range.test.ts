import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseByteRange } from "../byte-range.ts";

describe("parseByteRange", () => {
  it("parses bounded, open-ended and suffix ranges", () => {
    assert.deepEqual(parseByteRange("bytes=0-99", 1000), { start: 0, end: 99 });
    assert.deepEqual(parseByteRange("bytes=200-", 1000), { start: 200, end: 999 });
    assert.deepEqual(parseByteRange("bytes=-100", 1000), { start: 900, end: 999 });
  });

  it("clamps end to file size", () => {
    assert.deepEqual(parseByteRange("bytes=0-5000", 1000), { start: 0, end: 999 });
  });

  it("rejects invalid or unsatisfiable ranges", () => {
    assert.equal(parseByteRange(undefined, 1000), null);
    assert.equal(parseByteRange("bytes=1000-", 1000), null);
    assert.equal(parseByteRange("bytes=-0", 1000), null);
    assert.equal(parseByteRange("bytes=5-2", 1000), null);
    assert.equal(parseByteRange("bytes=0-10,20-30", 1000), null);
    assert.equal(parseByteRange("bytes=0-", 0), null);
  });
});
