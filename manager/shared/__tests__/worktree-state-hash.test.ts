import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { worktreeStateHash } from "../worktree-state-hash.ts";

// Records which dir git was asked about, so we can assert the cwd fallback.
function fakeGit(diff: string | null = "diff-text") {
  const seen: string[] = [];
  return {
    seen,
    fullDiff: async (dir: string) => { seen.push(dir); return diff; },
    changedFiles: async (dir: string) => { seen.push(dir); return [{ path: "a.ts", status: "M", untracked: false }] as any; },
  };
}

describe("worktreeStateHash", () => {
  it("returns '' when there is no dir to measure", async () => {
    const git = fakeGit();
    assert.equal(await worktreeStateHash(git, {}), "");
    assert.deepEqual(git.seen, []); // git never touched
  });

  it("falls back to cwd when there is no worktree (cwd worker gets a signal)", async () => {
    const git = fakeGit();
    const h = await worktreeStateHash(git, { cwd: "/repo" });
    assert.notEqual(h, "");
    assert.ok(git.seen.every((d) => d === "/repo")); // hashed the cwd
  });

  it("prefers the worktree dir over cwd when both are present", async () => {
    const git = fakeGit();
    await worktreeStateHash(git, { worktreeDir: "/wt", cwd: "/repo" });
    assert.ok(git.seen.every((d) => d === "/wt"));
  });

  it("identical change-set ⇒ identical hash", async () => {
    const a = await worktreeStateHash(fakeGit("same"), { cwd: "/repo" });
    const b = await worktreeStateHash(fakeGit("same"), { cwd: "/repo" });
    assert.equal(a, b);
  });
});
