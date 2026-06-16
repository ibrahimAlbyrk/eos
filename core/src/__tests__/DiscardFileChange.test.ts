import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { discardFileChange } from "../use-cases/DiscardFileChange.ts";
import type { GitInfo } from "../ports/GitInfo.ts";
import type { ChangedFile } from "../../../contracts/src/http.ts";
import type { WorkingTreeRestore } from "../ports/WorkingTreeRestore.ts";

function gitStub(files: ChangedFile[]): Pick<GitInfo, "changedFiles"> {
  return { changedFiles: async () => files };
}

function recordingRestore(): { restore: WorkingTreeRestore; restores: unknown[]; cleans: unknown[] } {
  const restores: unknown[] = [];
  const cleans: unknown[] = [];
  return {
    restores,
    cleans,
    restore: {
      async restoreToBase(cwd, paths, base) { restores.push({ cwd, paths, base }); return { ok: true }; },
      async removeUntracked(cwd, paths) { cleans.push({ cwd, paths }); return { ok: true }; },
    },
  };
}

function file(over: Partial<ChangedFile> & { path: string }): ChangedFile {
  return { status: "M", insertions: 1, deletions: 0, untracked: false, ...over };
}

describe("discardFileChange", () => {
  it("restores a modified tracked file to base (index + worktree)", async () => {
    const r = recordingRestore();
    const res = await discardFileChange(
      { git: gitStub([file({ path: "a.txt" })]), restore: r.restore },
      { cwd: "/repo", path: "a.txt", base: "BASE" },
    );
    assert.deepEqual(res, { ok: true });
    assert.deepEqual(r.restores, [{ cwd: "/repo", paths: ["a.txt"], base: "BASE" }]);
    assert.equal(r.cleans.length, 0);
  });

  it("removes an untracked file via clean, never restore", async () => {
    const r = recordingRestore();
    await discardFileChange(
      { git: gitStub([file({ path: "new.txt", status: "A", untracked: true, insertions: null, deletions: null })]), restore: r.restore },
      { cwd: "/repo", path: "new.txt" },
    );
    assert.deepEqual(r.cleans, [{ cwd: "/repo", paths: ["new.txt"] }]);
    assert.equal(r.restores.length, 0);
  });

  it("restores a rename's original AND new path in one call", async () => {
    const r = recordingRestore();
    await discardFileChange(
      { git: gitStub([file({ path: "new.txt", oldPath: "old.txt", status: "R" })]), restore: r.restore },
      { cwd: "/repo", path: "new.txt", base: "BASE" },
    );
    assert.deepEqual(r.restores, [{ cwd: "/repo", paths: ["old.txt", "new.txt"], base: "BASE" }]);
  });

  it("is an idempotent no-op when the path is no longer changed", async () => {
    const r = recordingRestore();
    const res = await discardFileChange(
      { git: gitStub([file({ path: "other.txt" })]), restore: r.restore },
      { cwd: "/repo", path: "gone.txt" },
    );
    assert.deepEqual(res, { ok: true });
    assert.equal(r.restores.length, 0);
    assert.equal(r.cleans.length, 0);
  });

  it("surfaces a restore failure verbatim", async () => {
    const restore: WorkingTreeRestore = {
      async restoreToBase() { return { ok: false, error: "fatal: bad source" }; },
      async removeUntracked() { return { ok: true }; },
    };
    const res = await discardFileChange(
      { git: gitStub([file({ path: "a.txt" })]), restore },
      { cwd: "/repo", path: "a.txt" },
    );
    assert.deepEqual(res, { ok: false, error: "fatal: bad source" });
  });
});
