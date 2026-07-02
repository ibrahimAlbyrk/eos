import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ToolResultBlockSchema, PatchHunkSchema, parseStructuredPatch } from "../canonical.ts";

describe("ToolResultBlockSchema.patch (optional, additive)", () => {
  it("accepts a tool_result block WITHOUT patch (persisted rows stay valid)", () => {
    const r = ToolResultBlockSchema.safeParse({ type: "tool_result", callId: "c1", content: "ok" });
    assert.ok(r.success);
    assert.equal(r.data.patch, undefined);
  });

  it("accepts a tool_result block WITH a patch of hunks", () => {
    const r = ToolResultBlockSchema.safeParse({
      type: "tool_result", callId: "c1", isError: false, content: "ok",
      patch: [{ oldStart: 35, newStart: 35, lines: ["-b", "+x"] }],
    });
    assert.ok(r.success);
    assert.equal(r.data.patch?.length, 1);
    assert.equal(r.data.patch?.[0].oldStart, 35);
    assert.deepEqual(r.data.patch?.[0].lines, ["-b", "+x"]);
  });

  it("rejects a patch hunk missing absolute line numbers", () => {
    const r = PatchHunkSchema.safeParse({ oldStart: 1, lines: ["-a"] });
    assert.equal(r.success, false);
  });
});

describe("parseStructuredPatch (shared extractor for both ACLs)", () => {
  it("slims a valid structuredPatch to {oldStart,newStart,lines}", () => {
    const hunks = parseStructuredPatch([
      { oldStart: 10, oldLines: 2, newStart: 10, newLines: 3, lines: ["-a", "+b", "+c"] },
    ]);
    assert.deepEqual(hunks, [{ oldStart: 10, newStart: 10, lines: ["-a", "+b", "+c"] }]);
  });

  it("returns undefined for absent / empty / non-array input", () => {
    assert.equal(parseStructuredPatch(undefined), undefined);
    assert.equal(parseStructuredPatch(null), undefined);
    assert.equal(parseStructuredPatch([]), undefined);
    assert.equal(parseStructuredPatch("nope"), undefined);
  });

  it("degrades to undefined on garbage hunks (never throws)", () => {
    assert.equal(parseStructuredPatch([{ foo: "bar" }]), undefined);
    // lines present but not strings → the hunk is skipped, none survive.
    assert.equal(parseStructuredPatch([{ oldStart: 1, newStart: 1, lines: [1, 2, 3] }]), undefined);
    assert.doesNotThrow(() => parseStructuredPatch(42));
  });

  it("keeps only the valid hunks when a batch is mixed", () => {
    const hunks = parseStructuredPatch([
      { oldStart: 1, newStart: 1, lines: ["-a"] },
      { oldStart: "bad", newStart: 2, lines: ["+b"] },
    ]);
    assert.deepEqual(hunks, [{ oldStart: 1, newStart: 1, lines: ["-a"] }]);
  });
});
