import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { childProcessGitInfo as gitInfo } from "../git/ChildProcessGitInfo.ts";
import { childProcessBranchAdmin as branchAdmin } from "../git/ChildProcessBranchAdmin.ts";
import { childProcessRemoteSync as remoteSync } from "../git/ChildProcessRemoteSync.ts";

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return (r.stdout ?? "") + (r.stderr ?? "");
}

function init(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.email", "t@e.st");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
  return dir;
}

function commit(cwd: string, file: string, body: string): void {
  writeFileSync(join(cwd, file), body);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", `add ${file}`);
}

describe("ChildProcessBranchAdmin (local repo)", () => {
  let repo: string;

  before(() => {
    repo = init("eos-badmin-");
    commit(repo, "a.txt", "hello");
  });
  after(() => rmSync(repo, { recursive: true, force: true }));

  it("creates & switches to a new branch", async () => {
    const r = await branchAdmin.create(repo, "feature/x", null, { checkout: true });
    assert.equal(r.ok, true);
    assert.equal(r.branch, "feature/x");
    assert.equal(await gitInfo.currentBranch(repo), "feature/x");
  });

  it("creates a branch without switching", async () => {
    const r = await branchAdmin.create(repo, "side", null, { checkout: false });
    assert.equal(r.ok, true);
    assert.equal(await gitInfo.currentBranch(repo), "feature/x");
    assert.ok((await gitInfo.listBranches(repo)).includes("side"));
  });

  it("rejects creating a duplicate branch", async () => {
    const r = await branchAdmin.create(repo, "side", null, { checkout: false });
    assert.equal(r.ok, false);
    assert.ok(r.error && r.error.length > 0);
  });

  it("renames a branch", async () => {
    const r = await branchAdmin.rename(repo, "side", "renamed");
    assert.equal(r.ok, true);
    const branches = await gitInfo.listBranches(repo);
    assert.ok(branches.includes("renamed"));
    assert.ok(!branches.includes("side"));
  });

  it("deletes a merged branch", async () => {
    const r = await branchAdmin.remove(repo, "renamed", { force: false });
    assert.equal(r.ok, true);
    assert.equal(r.deleted, true);
    assert.ok(!(await gitInfo.listBranches(repo)).includes("renamed"));
  });

  it("flags a not-fully-merged branch instead of force-deleting", async () => {
    git(repo, "checkout", "-b", "unmerged");
    commit(repo, "b.txt", "world");
    git(repo, "checkout", "feature/x");
    const soft = await branchAdmin.remove(repo, "unmerged", { force: false });
    assert.equal(soft.ok, false);
    assert.equal(soft.notMerged, true);
    // Force then succeeds.
    const hard = await branchAdmin.remove(repo, "unmerged", { force: true });
    assert.equal(hard.ok, true);
  });
});

describe("remote listing + fetch + ff pull + remote delete", () => {
  let bare: string;
  let a: string;
  let b: string;

  before(() => {
    bare = realpathSync(mkdtempSync(join(tmpdir(), "eos-bare-")));
    spawnSync("git", ["init", "--bare", "-b", "main", bare], { encoding: "utf8" });

    a = init("eos-remote-a-");
    git(a, "remote", "add", "origin", bare);
    commit(a, "a.txt", "one");
    git(a, "push", "-u", "origin", "main");

    b = init("eos-remote-b-");
    git(b, "remote", "add", "origin", bare);
    git(b, "fetch", "origin");
    git(b, "checkout", "main");
    git(b, "config", "user.email", "t@e.st");
    git(b, "config", "user.name", "Test");
  });
  after(() => {
    for (const d of [bare, a, b]) rmSync(d, { recursive: true, force: true });
  });

  it("lists remotes and remote-tracking branches (origin/HEAD excluded)", async () => {
    assert.deepEqual(await gitInfo.remotes(a), ["origin"]);
    const remote = await gitInfo.remoteBranches(a);
    assert.ok(remote.includes("origin/main"));
    assert.ok(!remote.some((r) => r.endsWith("/HEAD")));
  });

  it("reports up-to-date pull state right after push", async () => {
    const st = await gitInfo.pullState(a);
    assert.equal(st.branch, "main");
    assert.equal(st.hasUpstream, true);
    assert.equal(st.behind, 0);
  });

  it("fast-forward pulls a remote advance", async () => {
    // b advances origin/main; a is now strictly behind.
    commit(b, "b.txt", "two");
    git(b, "push", "origin", "main");
    const fetched = await remoteSync.fetch(a, { prune: true });
    assert.equal(fetched.ok, true);

    const behindState = await gitInfo.pullState(a);
    assert.equal(behindState.behind, 1);
    assert.equal(behindState.ahead, 0);

    const exec = await remoteSync.pull(a);
    assert.equal(exec.ok, true);
    assert.equal(exec.reason, "pulled");
    assert.equal((await gitInfo.pullState(a)).behind, 0);
  });

  it("deletes a branch on the remote", async () => {
    git(a, "push", "origin", "main:throwaway");
    await remoteSync.fetch(a, { prune: false });
    assert.ok((await gitInfo.remoteBranches(a)).includes("origin/throwaway"));

    const del = await remoteSync.deleteRemoteBranch(a, "origin", "throwaway");
    assert.equal(del.ok, true);
    await remoteSync.fetch(a, { prune: true });
    assert.ok(!(await gitInfo.remoteBranches(a)).includes("origin/throwaway"));
  });
});
