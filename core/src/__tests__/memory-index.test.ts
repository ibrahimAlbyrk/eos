import { test } from "node:test";
import assert from "node:assert/strict";
import { removeFromIndex } from "../domain/memory-index.ts";

test("removeFromIndex drops only the matching line", () => {
  assert.equal(removeFromIndex("- [a](a.md) — x\n- [b](b.md) — y", "a"), "- [b](b.md) — y");
});

test("removeFromIndex is a no-op when the name is absent", () => {
  assert.equal(removeFromIndex("- [a](a.md) — x", "zzz"), "- [a](a.md) — x");
});
