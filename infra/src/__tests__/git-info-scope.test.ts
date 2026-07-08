// The Git Diff panel's scope plumbing: paged log, default-branch resolution,
// in-repo merge-base, ref resolution, commit patches, and blob reads — all
// against a real throwaway git repo (same harness as git-changes.test.ts).

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { childProcessGitInfo as gitInfo, parseLogRecords } from "../git/ChildProcessGitInfo.ts";
import { attachPatches, PATCH_MAX_BYTES, PATCHES_TOTAL_MAX_BYTES } from "../git/changes-parse.ts";
import type { ChangedFile } from "../../../contracts/src/http.ts";

function git(cwd: string, ...args: string[]): { code: number; out: string } {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return { code: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

function initRepo(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  assert.equal(git(dir, "init", "-b", "main").code, 0);
  git(dir, "config", "user.email", "t@t.t");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  return dir;
}

describe("parseLogRecords", () => {
  it("parses unit/record-separated log output", () => {
    const out = "abc123\x1fAlice\x1f1700000000\x1ffix: a; b\x1e" + "def456\x1fBob\x1f1700000100\x1ffeat x\x1e";
    assert.deepEqual(parseLogRecords(out), [
      { sha: "abc123", author: "Alice", ts: 1700000000000, subject: "fix: a; b" },
      { sha: "def456", author: "Bob", ts: 1700000100000, subject: "feat x" },
    ]);
  });

  it("returns [] for empty output and drops sha-less records", () => {
    assert.deepEqual(parseLogRecords(""), []);
    assert.deepEqual(parseLogRecords("\x1fx\x1f1\x1fs\x1e"), []);
  });
});

describe("log / defaultBranch / mergeBaseWith / revParse (real repo)", () => {
  let repo: string;

  before(() => {
    repo = initRepo("eos-scope-");
    for (const n of [1, 2, 3]) {
      writeFileSync(join(repo, "f.txt"), `line ${n}\n`);
      git(repo, "add", "-A");
      assert.equal(git(repo, "commit", "-qm", `c${n}`).code, 0);
    }
  });

  after(() => {
    try { rmSync(repo, { recursive: true, force: true }); } catch {}
  });

  it("log fetches limit+1 rows newest first; skip pages past them", async () => {
    const rows = await gitInfo.log(repo, { limit: 2, skip: 0 });
    assert.equal(rows.length, 3); // limit+1 — the overflow row answers hasMore
    assert.deepEqual(rows.map((r) => r.subject), ["c3", "c2", "c1"]);

    const page2 = await gitInfo.log(repo, { limit: 2, skip: 2 });
    assert.deepEqual(page2.map((r) => r.subject), ["c1"]);
  });

  it("log returns [] on a non-repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eos-norepo-"));
    try {
      assert.deepEqual(await gitInfo.log(dir, { limit: 10, skip: 0 }), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaultBranch falls back to a local main/master without origin/HEAD", async () => {
    assert.equal(await gitInfo.defaultBranch(repo), "main");
  });

  it("defaultBranch prefers the origin/HEAD symref when present", async () => {
    // Simulate a clone whose remote default is `trunk` (not main).
    git(repo, "branch", "trunk");
    assert.equal(git(repo, "update-ref", "refs/remotes/origin/trunk", "HEAD").code, 0);
    assert.equal(git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk").code, 0);
    try {
      assert.equal(await gitInfo.defaultBranch(repo), "trunk");
    } finally {
      git(repo, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
      git(repo, "update-ref", "-d", "refs/remotes/origin/trunk");
      git(repo, "branch", "-D", "trunk");
    }
  });

  it("defaultBranch is null on a non-repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eos-norepo-"));
    try {
      assert.equal(await gitInfo.defaultBranch(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("mergeBaseWith finds the in-repo fork point; bad ref → null", async () => {
    const forkPoint = git(repo, "rev-parse", "HEAD").out.trim();
    git(repo, "checkout", "-qb", "feature");
    writeFileSync(join(repo, "g.txt"), "feature\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "feature work");
    try {
      assert.equal(await gitInfo.mergeBaseWith(repo, "main"), forkPoint);
      assert.equal(await gitInfo.mergeBaseWith(repo, "no-such-ref"), null);
    } finally {
      git(repo, "checkout", "-q", "main");
      git(repo, "branch", "-D", "feature");
    }
  });

  it("revParse resolves refs to short shas; bad ref → null", async () => {
    const short = await gitInfo.revParse(repo, "HEAD");
    assert.ok(short && short.length >= 4);
    assert.ok(git(repo, "rev-parse", "HEAD").out.trim().startsWith(short));
    assert.equal(await gitInfo.revParse(repo, "deadbeefdeadbeef"), null);
  });
});

describe("commitPatch / commitFileDiff / blobs (real repo)", () => {
  let repo: string;
  let sha: string;

  before(() => {
    repo = initRepo("eos-cpatch-");
    writeFileSync(join(repo, "a.txt"), "alpha\n");
    writeFileSync(join(repo, "b.txt"), "bravo\n");
    git(repo, "add", "-A");
    assert.equal(git(repo, "commit", "-qm", "init").code, 0);
    writeFileSync(join(repo, "a.txt"), "alpha changed\n");
    writeFileSync(join(repo, "b.txt"), "bravo changed\n");
    git(repo, "add", "-A");
    assert.equal(git(repo, "commit", "-qm", "touch both").code, 0);
    sha = git(repo, "rev-parse", "HEAD").out.trim();
  });

  after(() => {
    try { rmSync(repo, { recursive: true, force: true }); } catch {}
  });

  // The frontend relies on ?patches=1 embedding — prove the `git show` output
  // splits per-file through the same attachPatches used for `git diff`.
  it("attachPatches splits a git-show commit patch per file (fixture)", async () => {
    const full = await gitInfo.commitPatch(repo, sha);
    assert.ok(full);
    const files: ChangedFile[] = [
      { path: "a.txt", status: "M", untracked: false, insertions: 1, deletions: 1 },
      { path: "b.txt", status: "M", untracked: false, insertions: 1, deletions: 1 },
    ];
    attachPatches(files, full!, PATCH_MAX_BYTES, PATCHES_TOTAL_MAX_BYTES);
    assert.match(files[0].patch ?? "", /^\+alpha changed$/m);
    assert.doesNotMatch(files[0].patch ?? "", /bravo/);
    assert.match(files[1].patch ?? "", /^\+bravo changed$/m);
    assert.doesNotMatch(files[1].patch ?? "", /alpha/);
  });

  it("commitPatch is null for a bogus sha", async () => {
    assert.equal(await gitInfo.commitPatch(repo, "deadbeefdeadbeef"), null);
  });

  it("commitFileDiff isolates one file's diff within the commit", async () => {
    const r = await gitInfo.commitFileDiff(repo, sha, "a.txt");
    assert.equal(r.binary, false);
    assert.match(r.patch, /^-alpha$/m);
    assert.match(r.patch, /^\+alpha changed$/m);
    assert.doesNotMatch(r.patch, /bravo/);
  });

  it("commitFileDiff collapses to an empty patch on error", async () => {
    const r = await gitInfo.commitFileDiff(repo, "deadbeefdeadbeef", "a.txt");
    assert.deepEqual(r, { path: "a.txt", patch: "", binary: false, truncated: false });
  });

  it("blobSizeAtRef + blobAtRef read exact bytes at a ref; missing → null", async () => {
    assert.equal(await gitInfo.blobSizeAtRef(repo, sha, "a.txt"), "alpha changed\n".length);
    const bytes = await gitInfo.blobAtRef(repo, sha, "a.txt");
    assert.ok(bytes);
    assert.equal(Buffer.from(bytes!).toString("utf8"), "alpha changed\n");

    assert.equal(await gitInfo.blobSizeAtRef(repo, sha, "nope.txt"), null);
    assert.equal(await gitInfo.blobAtRef(repo, sha, "nope.txt"), null);
  });
});
