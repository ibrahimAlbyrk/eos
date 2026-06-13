import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { listConflicts } from "../use-cases/ListConflicts.ts";
import { getConflictDocument } from "../use-cases/GetConflictDocument.ts";
import { resolveConflictFile } from "../use-cases/ResolveConflictFile.ts";
import type { GitInfo, ConflictEntry } from "../ports/GitInfo.ts";
import type { ConflictResolution } from "../ports/ConflictResolution.ts";

const MERGE = "a\n<<<<<<< HEAD\nY\n=======\nX\n>>>>>>> feat\nc\n";
const TWO = "<<<<<<< A\n1\n=======\n2\n>>>>>>> B\nx\n<<<<<<< A\n3\n=======\n4\n>>>>>>> B\n";

// Only the three methods the conflict use-cases touch are implemented — the
// rest of GitInfo is never called here, so the cast is safe and focused.
function gitStub(opts: { conflicts?: ConflictEntry[]; content?: string; count?: number }): GitInfo {
  return {
    conflictList: async () => opts.conflicts ?? [],
    conflictFileContent: async () => opts.content ?? "",
    conflictCount: async () => opts.count ?? 0,
  } as unknown as GitInfo;
}

function recordingResolver(): { res: ConflictResolution; writes: unknown[]; sides: unknown[] } {
  const writes: unknown[] = [];
  const sides: unknown[] = [];
  return {
    writes,
    sides,
    res: {
      async writeResolved(cwd, path, content) { writes.push({ cwd, path, content }); },
      async takeSide(cwd, path, side, kind) { sides.push({ cwd, path, side, kind }); },
    },
  };
}

describe("listConflicts", () => {
  it("classifies each unmerged file by its porcelain code", async () => {
    const git = gitStub({ conflicts: [{ path: "a", xy: "UU" }, { path: "b", xy: "UD" }] });
    assert.deepEqual(await listConflicts({ git }, "/repo"), {
      files: [
        { path: "a", xy: "UU", kind: "content" },
        { path: "b", xy: "UD", kind: "theirs-deleted" },
      ],
    });
  });
});

describe("getConflictDocument", () => {
  it("parses a content conflict into segments with a fingerprint", async () => {
    const git = gitStub({ conflicts: [{ path: "f", xy: "UU" }], content: MERGE });
    const doc = await getConflictDocument({ git }, "/repo", "f");
    assert.equal(doc?.kind, "content");
    assert.equal(doc?.style, "merge");
    assert.equal(doc?.conflictCount, 1);
    assert.equal(doc?.segments.length, 3);
    assert.ok(doc && doc.fingerprint.length > 0);
  });

  it("returns a markerless 'none' document for add/delete conflicts", async () => {
    const git = gitStub({ conflicts: [{ path: "f", xy: "UD" }] });
    const doc = await getConflictDocument({ git }, "/repo", "f");
    assert.equal(doc?.kind, "theirs-deleted");
    assert.equal(doc?.style, "none");
    assert.deepEqual(doc?.segments, []);
  });

  it("returns null when the path is no longer conflicted", async () => {
    assert.equal(await getConflictDocument({ git: gitStub({ conflicts: [] }) }, "/repo", "f"), null);
  });
});

describe("resolveConflictFile", () => {
  it("writes the assembled content + stages when every hunk is resolved", async () => {
    const git = gitStub({ conflicts: [{ path: "f", xy: "UU" }], content: MERGE, count: 0 });
    const { res, writes } = recordingResolver();
    const out = await resolveConflictFile({ git, conflicts: res }, "/repo", {
      path: "f",
      resolutions: [{ id: 0, choice: "ours" }],
    });
    assert.deepEqual(out, { ok: true, staged: true, unresolved: [], remaining: 0 });
    assert.deepEqual(writes, [{ cwd: "/repo", path: "f", content: "a\nY\nc\n" }]);
  });

  it("does not write while hunks remain unresolved", async () => {
    const git = gitStub({ conflicts: [{ path: "f", xy: "UU" }], content: TWO, count: 1 });
    const { res, writes } = recordingResolver();
    const out = await resolveConflictFile({ git, conflicts: res }, "/repo", {
      path: "f",
      resolutions: [{ id: 0, choice: "ours" }],
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, "incomplete");
    assert.deepEqual(out.unresolved, [1]);
    assert.equal(writes.length, 0);
  });

  it("rejects a stale apply when the fingerprint no longer matches", async () => {
    const git = gitStub({ conflicts: [{ path: "f", xy: "UU" }], content: MERGE });
    const { res, writes } = recordingResolver();
    const out = await resolveConflictFile({ git, conflicts: res }, "/repo", {
      path: "f",
      fingerprint: "stale-token",
      resolutions: [{ id: 0, choice: "ours" }],
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, "stale");
    assert.equal(writes.length, 0);
  });

  it("applies the whole-file side for an add/delete conflict", async () => {
    const git = gitStub({ conflicts: [{ path: "g", xy: "UD" }], count: 0 });
    const { res, sides } = recordingResolver();
    const out = await resolveConflictFile({ git, conflicts: res }, "/repo", { path: "g", side: "theirs" });
    assert.deepEqual(out, { ok: true, staged: true, unresolved: [], remaining: 0 });
    assert.deepEqual(sides, [{ cwd: "/repo", path: "g", side: "theirs", kind: "theirs-deleted" }]);
  });

  it("fails cleanly when the path is not conflicted", async () => {
    const { res } = recordingResolver();
    const out = await resolveConflictFile({ git: gitStub({ conflicts: [] }), conflicts: res }, "/repo", {
      path: "missing",
      side: "ours",
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, "not-conflicted");
  });
});
