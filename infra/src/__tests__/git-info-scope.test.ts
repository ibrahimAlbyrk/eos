// The Git Diff panel's scope plumbing: paged log, default-branch resolution,
// in-repo merge-base, ref resolution, commit patches, and blob reads — all
// against a real throwaway git repo (same harness as git-changes.test.ts).

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { childProcessGitInfo as gitInfo, parseLogRecords, parseStashRecords } from "../git/ChildProcessGitInfo.ts";
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

describe("parseStashRecords", () => {
  it("parses records, position = stash index, ts in ms", () => {
    const out = "aaa111\x1f1700000000\x1fWIP on main: 1234abc fix thing\x1e" +
      "bbb222\x1f1700000100\x1fOn feat/x: my custom message\x1e";
    assert.deepEqual(parseStashRecords(out), [
      { index: 0, sha: "aaa111", ts: 1700000000000, subject: "WIP on main: 1234abc fix thing", branch: "main" },
      { index: 1, sha: "bbb222", ts: 1700000100000, subject: "On feat/x: my custom message", branch: "feat/x" },
    ]);
  });

  it("branch is null when the subject has no WIP-on/On prefix", () => {
    const [s] = parseStashRecords("ccc333\x1f1700000000\x1fautostash\x1e");
    assert.equal(s.branch, null);
    assert.equal(s.subject, "autostash");
  });

  it("returns [] for empty output", () => {
    assert.deepEqual(parseStashRecords(""), []);
  });
});

describe("log / revParse (real repo)", () => {
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

  // Regression lock: single-parent commits keep their exact pre-first-parent
  // behavior (the flag only changes how MERGE commits are diffed).
  it("commitDetail on a single-parent commit lists per-file changes as before", async () => {
    const detail = await gitInfo.commitDetail(repo, sha);
    assert.ok(detail);
    assert.deepEqual(detail!.files.map((f) => f.path), ["a.txt", "b.txt"]);
    assert.equal(detail!.insertions, 2);
    assert.equal(detail!.deletions, 2);
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

// Stash entries are merge commits — the CRITICAL case /fs/changes?sha= must
// handle. Default `git show` renders merges empty; first-parent must surface
// the stashed files in stats, whole patch, and single-file diff.
describe("stashList + merge-commit diffs (real repo)", () => {
  let repo: string;
  let stashSha: string;

  before(() => {
    repo = initRepo("eos-stash-");
    writeFileSync(join(repo, "tracked.txt"), "one\n");
    git(repo, "add", "-A");
    assert.equal(git(repo, "commit", "-qm", "init").code, 0);
    // Stash a tracked edit + an untracked file (so the stash has the third
    // parent too) — then the stash commit is a merge over HEAD.
    writeFileSync(join(repo, "tracked.txt"), "one\ntwo\n");
    writeFileSync(join(repo, "untracked.txt"), "brand new\n");
    assert.equal(git(repo, "stash", "push", "-u", "-m", "my work").code, 0);
    stashSha = git(repo, "rev-parse", "--short", "stash@{0}").out.trim();
  });

  after(() => {
    try { rmSync(repo, { recursive: true, force: true }); } catch {}
  });

  it("stashList reports index/sha/subject/branch newest first", async () => {
    const stashes = await gitInfo.stashList(repo);
    assert.equal(stashes.length, 1);
    assert.equal(stashes[0].index, 0);
    assert.ok(stashes[0].sha.length >= 4);
    assert.equal(stashes[0].branch, "main");
    assert.match(stashes[0].subject, /my work/);
    assert.ok(stashes[0].ts > 0);
  });

  it("stashList → [] on a non-repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eos-norepo-"));
    try {
      assert.deepEqual(await gitInfo.stashList(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // First-parent = the stash's tracked working-tree changes vs pre-stash HEAD.
  // (Untracked files stashed with -u live in the stash's third parent, so they
  // are correctly absent from this diff — matching `git stash show`.)
  it("commitDetail on a stash merge lists the stashed files (first-parent)", async () => {
    const detail = await gitInfo.commitDetail(repo, stashSha);
    assert.ok(detail);
    const paths = detail!.files.map((f) => f.path);
    assert.ok(paths.includes("tracked.txt"), `expected tracked.txt in ${paths}`);
    assert.ok(detail!.insertions >= 1);
  });

  it("commitPatch on a stash merge emits per-file hunks (not an empty combined diff)", async () => {
    const patch = await gitInfo.commitPatch(repo, stashSha);
    assert.ok(patch);
    assert.match(patch!, /^\+two$/m);
    assert.match(patch!, /diff --git a\/tracked\.txt/);
  });

  it("commitFileDiff on a stash merge isolates one file", async () => {
    const r = await gitInfo.commitFileDiff(repo, stashSha, "tracked.txt");
    assert.equal(r.binary, false);
    assert.match(r.patch, /^\+two$/m);
    assert.doesNotMatch(r.patch, /brand new/);
  });

  it("revParse(`${stashSha}^`) resolves to the first parent (pre-stash HEAD)", async () => {
    const firstParent = await gitInfo.revParse(repo, `${stashSha}^`);
    const headBefore = git(repo, "rev-parse", "--short", `${stashSha}^1`).out.trim();
    assert.equal(firstParent, headBefore);
  });
});

describe("stashApply / stashDrop (real repo)", () => {
  // Fresh repo per test: one commit ("base\n") + one stash that changed the
  // tracked file to "stashed\n", leaving the working tree back at base.
  function repoWithStash(): string {
    const repo = initRepo("eos-stashmut-");
    writeFileSync(join(repo, "f.txt"), "base\n");
    git(repo, "add", "-A");
    assert.equal(git(repo, "commit", "-qm", "init").code, 0);
    writeFileSync(join(repo, "f.txt"), "stashed\n");
    assert.equal(git(repo, "stash", "push", "-m", "work").code, 0);
    return repo;
  }

  it("stashApply restores the stashed changes and keeps the entry", async () => {
    const repo = repoWithStash();
    try {
      const r = await gitInfo.stashApply(repo, 0);
      assert.deepEqual(r, { ok: true });
      assert.equal(readFileSync(join(repo, "f.txt"), "utf8"), "stashed\n");
      assert.equal((await gitInfo.stashList(repo)).length, 1); // apply keeps it
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("stashDrop removes the entry (stashList count decreases)", async () => {
    const repo = repoWithStash();
    try {
      assert.equal((await gitInfo.stashList(repo)).length, 1);
      const r = await gitInfo.stashDrop(repo, 0);
      assert.deepEqual(r, { ok: true });
      assert.equal((await gitInfo.stashList(repo)).length, 0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("stashApply returns { ok:false, error } on conflict — no throw", async () => {
    const repo = repoWithStash();
    try {
      // Dirty the same line the stash touches → apply conflicts.
      writeFileSync(join(repo, "f.txt"), "working divergent\n");
      const r = await gitInfo.stashApply(repo, 0);
      assert.equal(r.ok, false);
      assert.ok(r.error && r.error.length > 0, "expected git stderr in error");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("stashDrop on a bad index returns { ok:false, error }", async () => {
    const repo = repoWithStash();
    try {
      const r = await gitInfo.stashDrop(repo, 99);
      assert.equal(r.ok, false);
      assert.ok(r.error && r.error.length > 0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
