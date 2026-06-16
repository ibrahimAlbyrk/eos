import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { childProcessGitInfo as gitInfo } from "../git/ChildProcessGitInfo.ts";
import { childProcessWorkingTreeRestore as restore } from "../git/ChildProcessWorkingTreeRestore.ts";

function git(cwd: string, ...args: string[]): void {
  spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

const repos: string[] = [];
function init(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "eos-wtr-")));
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.email", "t@e.st");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
  repos.push(dir);
  return dir;
}
const read = (dir: string, f: string): string => readFileSync(join(dir, f), "utf8");
const write = (dir: string, f: string, body: string): void => writeFileSync(join(dir, f), body);

after(() => { for (const d of repos) rmSync(d, { recursive: true, force: true }); });

describe("ChildProcessWorkingTreeRestore (local repo)", () => {
  let repo: string;
  beforeEach(() => {
    repo = init();
    write(repo, "mod.txt", "base\n");
    write(repo, "del.txt", "base\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "base");
  });

  it("reverts a modified file to HEAD (index + worktree)", async () => {
    write(repo, "mod.txt", "changed\n");
    git(repo, "add", "mod.txt");
    const r = await restore.restoreToBase(repo, ["mod.txt"]);
    assert.equal(r.ok, true);
    assert.equal(read(repo, "mod.txt"), "base\n");
    assert.equal(await gitInfo.hasUncommittedChanges(repo), false);
  });

  it("restores a deleted file", async () => {
    git(repo, "rm", "del.txt");
    const r = await restore.restoreToBase(repo, ["del.txt"]);
    assert.equal(r.ok, true);
    assert.equal(read(repo, "del.txt"), "base\n");
  });

  it("removes a staged new file (absent at base)", async () => {
    write(repo, "added.txt", "new\n");
    git(repo, "add", "added.txt");
    const r = await restore.restoreToBase(repo, ["added.txt"]);
    assert.equal(r.ok, true);
    assert.equal(existsSync(join(repo, "added.txt")), false);
  });

  it("discards a rename: original returns, new path is removed (both paths, one call)", async () => {
    git(repo, "mv", "mod.txt", "renamed.txt");
    const r = await restore.restoreToBase(repo, ["mod.txt", "renamed.txt"]);
    assert.equal(r.ok, true);
    assert.equal(existsSync(join(repo, "renamed.txt")), false);
    assert.equal(read(repo, "mod.txt"), "base\n");
  });

  it("removeUntracked deletes an untracked file", async () => {
    write(repo, "junk.txt", "untracked\n");
    const r = await restore.removeUntracked(repo, ["junk.txt"]);
    assert.equal(r.ok, true);
    assert.equal(existsSync(join(repo, "junk.txt")), false);
  });

  it("restores to an explicit base across a later commit, leaving other files untouched", async () => {
    const baseSha = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    // A commit after the fork point, plus an uncommitted edit to mod.txt.
    write(repo, "committed.txt", "fork\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "fork work");
    write(repo, "mod.txt", "drifted\n");

    const r = await restore.restoreToBase(repo, ["mod.txt"], baseSha);
    assert.equal(r.ok, true);
    assert.equal(read(repo, "mod.txt"), "base\n");
    // mod.txt now matches base → gone from the base diff; committed.txt remains.
    const changed = (await gitInfo.changedFiles(repo, baseSha)).map((f) => f.path);
    assert.ok(!changed.includes("mod.txt"));
    assert.ok(changed.includes("committed.txt"));
  });

  it("surfaces a git failure as { ok:false, error }", async () => {
    const r = await restore.restoreToBase(repo, ["mod.txt"], "not-a-ref");
    assert.equal(r.ok, false);
    assert.ok((r.error ?? "").length > 0);
  });
});
