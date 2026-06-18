import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { childProcessWorktreeManager as wm } from "../git/ChildProcessWorktreeManager.ts";

let repo: string;

function git(cwd: string, ...args: string[]): { code: number; out: string } {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return { code: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

function addWorktree(branch: string): string {
  const dir = join(repo, ".eos", "worktrees", branch);
  mkdirSync(join(repo, ".eos", "worktrees"), { recursive: true });
  const r = git(repo, "worktree", "add", dir, "-b", branch);
  assert.equal(r.code, 0, `worktree add failed: ${r.out}`);
  return realpathSync(dir);
}

before(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "eos-wm-")));
  assert.equal(git(repo, "init").code, 0);
  git(repo, "config", "user.email", "t@t.t");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "README.md"), "hi\n");
  git(repo, "add", "-A");
  assert.equal(git(repo, "commit", "-m", "init").code, 0);
});

after(() => {
  try { rmSync(repo, { recursive: true, force: true }); } catch {}
});

describe("ChildProcessWorktreeManager.remove", () => {
  it("force-removes a worktree + branch even with uncommitted changes", async () => {
    const branch = "eos-dirty-1";
    const dir = addWorktree(branch);
    writeFileSync(join(dir, "scratch.txt"), "uncommitted work\n"); // dirty

    const res = await wm.remove({ repoRoot: repo, worktreeDir: dir, branch });
    assert.equal(res.removed, true);
    assert.equal(existsSync(dir), false, "worktree dir should be gone");
    assert.ok(!git(repo, "branch", "--list", branch).out.includes(branch), "branch should be deleted");
  });

  it("is idempotent — removing an already-gone ref resolves removed:true without throwing", async () => {
    const branch = "eos-twice-2";
    const dir = addWorktree(branch);
    await wm.remove({ repoRoot: repo, worktreeDir: dir, branch });
    const res = await wm.remove({ repoRoot: repo, worktreeDir: dir, branch });
    assert.equal(res.removed, true);
  });

  it("derives the dir from branch when worktreeDir is null", async () => {
    const branch = "eos-derive-3";
    const dir = addWorktree(branch);
    const res = await wm.remove({ repoRoot: repo, worktreeDir: null, branch });
    assert.equal(res.removed, true);
    assert.equal(existsSync(dir), false);
  });

  it("tags eos/trash before deleting a branch with unmerged commits", async () => {
    const branch = "eos-trash-5";
    const dir = addWorktree(branch);
    writeFileSync(join(dir, "work.txt"), "committed work\n");
    git(dir, "add", "-A");
    assert.equal(git(dir, "commit", "-m", "worker commit").code, 0);

    const res = await wm.remove({ repoRoot: repo, worktreeDir: dir, branch });
    assert.equal(res.removed, true);
    const tags = git(repo, "tag", "--list", `eos/trash/${branch}-*`).out.trim();
    assert.ok(tags.length > 0, "tombstone tag should exist");
    // The commit is still reachable via the tag.
    assert.equal(git(repo, "rev-parse", `${tags.split("\n")[0]}^{commit}`).code, 0);
  });

  it("does not tag when the branch has no unmerged commits", async () => {
    const branch = "eos-clean-6";
    const dir = addWorktree(branch);
    const res = await wm.remove({ repoRoot: repo, worktreeDir: dir, branch });
    assert.equal(res.removed, true);
    assert.equal(git(repo, "tag", "--list", `eos/trash/${branch}-*`).out.trim(), "");
  });

  it("refuses to remove the repo root itself", async () => {
    const res = await wm.remove({ repoRoot: repo, worktreeDir: repo, branch: "whatever" });
    assert.equal(res.removed, false);
    assert.ok(existsSync(repo), "repo root must survive");
  });
});

describe("ChildProcessWorktreeManager.listWorktrees", () => {
  it("flags the main worktree and parses eos-* branches", async () => {
    const branch = "eos-list-4";
    const dir = addWorktree(branch);
    const entries = await wm.listWorktrees(repo);

    const main = entries.find((e) => e.path === repo);
    assert.ok(main, "main worktree present");
    assert.equal(main!.isMain, true);

    const child = entries.find((e) => e.path === dir);
    assert.ok(child, "added worktree present");
    assert.equal(child!.isMain, false);
    assert.equal(child!.branch, branch);

    await wm.remove({ repoRoot: repo, worktreeDir: dir, branch }); // cleanup
  });
});

describe("ChildProcessWorktreeManager.create", () => {
  it("creates a worktree on a new branch and returns the realpath'd dir + fork base", async () => {
    const branch = "eos-create-1";
    const res = await wm.create({ repoRoot: repo, branch, worktreeDir: null });
    assert.equal(res.created, true);
    assert.ok(res.worktreeDir && existsSync(res.worktreeDir), "worktree dir exists");
    assert.equal(res.worktreeDir, realpathSync(join(repo, ".eos", "worktrees", branch)));
    assert.equal(res.forkBaseSha, git(repo, "rev-parse", "HEAD").out.trim());
    await wm.remove({ repoRoot: repo, worktreeDir: res.worktreeDir!, branch }); // cleanup
  });

  it("honors a precomputed worktreeDir", async () => {
    const branch = "eos-create-2";
    const dir = join(repo, ".eos", "worktrees", "custom-2");
    const res = await wm.create({ repoRoot: repo, branch, worktreeDir: dir });
    assert.equal(res.created, true);
    assert.equal(res.worktreeDir, realpathSync(dir));
    await wm.remove({ repoRoot: repo, worktreeDir: res.worktreeDir!, branch });
  });

  it("carryUncommitted forks from a snapshot of the source's dirty work", async () => {
    const scratch = join(repo, "carry-scratch.txt");
    writeFileSync(scratch, "uncommitted\n");
    const branch = "eos-create-carry-3";
    const res = await wm.create({ repoRoot: repo, branch, worktreeDir: null, carryUncommitted: true });
    assert.equal(res.created, true);
    assert.ok(existsSync(join(res.worktreeDir!, "carry-scratch.txt")), "dirty file carried into the worktree");
    await wm.remove({ repoRoot: repo, worktreeDir: res.worktreeDir!, branch });
    rmSync(scratch, { force: true }); // restore repo cleanliness for sibling tests
  });

  it("returns created:false (never throws) for a non-repo dir", async () => {
    const notRepo = realpathSync(mkdtempSync(join(tmpdir(), "eos-norepo-")));
    const res = await wm.create({ repoRoot: notRepo, branch: "x", worktreeDir: null });
    assert.equal(res.created, false);
    assert.ok(res.reason);
    rmSync(notRepo, { recursive: true, force: true });
  });

  it("hydrates gitignored node_modules from the source into the new worktree", async () => {
    writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
    mkdirSync(join(repo, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(repo, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
    const branch = "eos-create-hydrate-5";
    const res = await wm.create({ repoRoot: repo, branch, worktreeDir: null });
    assert.equal(res.created, true);
    assert.ok(existsSync(join(res.worktreeDir!, "node_modules", "pkg", "index.js")), "node_modules hydrated into worktree");
    await wm.remove({ repoRoot: repo, worktreeDir: res.worktreeDir!, branch });
    rmSync(join(repo, "node_modules"), { recursive: true, force: true });
    rmSync(join(repo, ".gitignore"), { force: true });
  });
});
