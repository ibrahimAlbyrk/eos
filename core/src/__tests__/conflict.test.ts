import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseConflictMarkers,
  assembleResolution,
  classifyConflict,
  isUnmergedCode,
  fingerprintOf,
  type HunkResolutionInput,
} from "../domain/conflict.ts";

const MERGE = "a\n<<<<<<< HEAD\nY\n=======\nX\n>>>>>>> feat\nc\n";
const DIFF3 = "a\n<<<<<<< HEAD\nY\n||||||| base\nZ\n=======\nX\n>>>>>>> feat\nc\n";
const TWO = "<<<<<<< A\n1\n=======\n2\n>>>>>>> B\nmid\n<<<<<<< A\n3\n=======\n4\n>>>>>>> B\n";

describe("parseConflictMarkers", () => {
  it("splits merge-style markers into context + conflict segments", () => {
    const doc = parseConflictMarkers(MERGE);
    assert.equal(doc.style, "merge");
    assert.equal(doc.conflictCount, 1);
    assert.deepEqual(doc.segments, [
      { kind: "context", lines: ["a"] },
      { kind: "conflict", id: 0, ours: ["Y"], base: null, theirs: ["X"] },
      { kind: "context", lines: ["c", ""] },
    ]);
  });

  it("captures the base section in diff3 style", () => {
    const doc = parseConflictMarkers(DIFF3);
    assert.equal(doc.style, "diff3");
    assert.deepEqual(doc.segments[1], { kind: "conflict", id: 0, ours: ["Y"], base: ["Z"], theirs: ["X"] });
  });

  it("returns unparseable on a missing separator", () => {
    const doc = parseConflictMarkers("a\n<<<<<<< HEAD\nY\n>>>>>>> feat\n");
    assert.equal(doc.style, "unparseable");
    assert.equal(doc.conflictCount, 0);
  });

  it("returns unparseable when no markers are present", () => {
    assert.equal(parseConflictMarkers("just\nplain\ntext\n").style, "unparseable");
  });

  it("preserves CRLF line endings verbatim in the segments", () => {
    const doc = parseConflictMarkers("a\r\n<<<<<<< HEAD\r\nY\r\n=======\r\nX\r\n>>>>>>> feat\r\nc\r\n");
    assert.equal(doc.conflictCount, 1);
    assert.deepEqual(doc.segments[1], { kind: "conflict", id: 0, ours: ["Y\r"], base: null, theirs: ["X\r"] });
  });

  it("numbers multiple hunks with stable ascending ids", () => {
    const doc = parseConflictMarkers(TWO);
    assert.equal(doc.conflictCount, 2);
    assert.deepEqual(doc.segments.filter((s) => s.kind === "conflict"), [
      { kind: "conflict", id: 0, ours: ["1"], base: null, theirs: ["2"] },
      { kind: "conflict", id: 1, ours: ["3"], base: null, theirs: ["4"] },
    ]);
  });
});

describe("assembleResolution", () => {
  it("emits the chosen side and round-trips context + trailing newline", () => {
    const doc = parseConflictMarkers(MERGE);
    assert.deepEqual(
      assembleResolution(doc, new Map<number, HunkResolutionInput>([[0, { id: 0, choice: "ours" }]])),
      { content: "a\nY\nc\n", unresolved: [] },
    );
    assert.equal(
      assembleResolution(doc, new Map<number, HunkResolutionInput>([[0, { id: 0, choice: "theirs" }]])).content,
      "a\nX\nc\n",
    );
  });

  it("uses hand-edited lines for a manual resolution", () => {
    const doc = parseConflictMarkers(MERGE);
    assert.equal(
      assembleResolution(doc, new Map<number, HunkResolutionInput>([[0, { id: 0, manual: ["MERGED"] }]])).content,
      "a\nMERGED\nc\n",
    );
  });

  it("reports unresolved hunks and never invents content for them", () => {
    const doc = parseConflictMarkers(TWO);
    const out = assembleResolution(doc, new Map<number, HunkResolutionInput>([[0, { id: 0, choice: "ours" }]]));
    assert.deepEqual(out.unresolved, [1]);
  });
});

describe("classifyConflict / isUnmergedCode", () => {
  it("maps every porcelain unmerged code to a kind", () => {
    assert.equal(classifyConflict("UU"), "content");
    assert.equal(classifyConflict("AA"), "content");
    assert.equal(classifyConflict("DU"), "ours-deleted");
    assert.equal(classifyConflict("UD"), "theirs-deleted");
    assert.equal(classifyConflict("AU"), "ours-added");
    assert.equal(classifyConflict("UA"), "theirs-added");
    assert.equal(classifyConflict("DD"), "both-deleted");
  });

  it("recognises exactly the unmerged set", () => {
    for (const xy of ["DD", "AU", "UD", "UA", "DU", "AA", "UU"]) assert.ok(isUnmergedCode(xy));
    for (const xy of [" M", "M ", "??", "A ", "R "]) assert.ok(!isUnmergedCode(xy));
  });
});

describe("fingerprintOf", () => {
  it("is deterministic and content-sensitive", () => {
    assert.equal(fingerprintOf("abc"), fingerprintOf("abc"));
    assert.notEqual(fingerprintOf("abc"), fingerprintOf("abd"));
    assert.notEqual(fingerprintOf("abc"), fingerprintOf("abc "));
  });
});
