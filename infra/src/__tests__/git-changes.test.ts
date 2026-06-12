import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { parsePorcelainZ, parseNumstatZ, mergeChanges, truncatePatch, splitUnifiedDiff, attachPatches } from "../git/changes-parse.ts";
import { childProcessGitInfo as gitInfo } from "../git/ChildProcessGitInfo.ts";

describe("parsePorcelainZ", () => {
  it("parses plain modified/added/deleted entries", () => {
    const out = " M src/a.ts\0A  lib/b.ts\0 D old.txt\0";
    assert.deepEqual(parsePorcelainZ(out), [
      { path: "src/a.ts", x: " ", y: "M" },
      { path: "lib/b.ts", x: "A", y: " " },
      { path: "old.txt", x: " ", y: "D" },
    ]);
  });

  it("parses untracked entries", () => {
    assert.deepEqual(parsePorcelainZ("?? new file.txt\0"), [
      { path: "new file.txt", x: "?", y: "?" },
    ]);
  });

  it("consumes the extra origin-path token on renames", () => {
    const out = "R  new.ts\0old.ts\0 M next.ts\0";
    assert.deepEqual(parsePorcelainZ(out), [
      { path: "new.ts", oldPath: "old.ts", x: "R", y: " " },
      { path: "next.ts", x: " ", y: "M" },
    ]);
  });

  it("returns [] for empty output", () => {
    assert.deepEqual(parsePorcelainZ(""), []);
  });
});

describe("parseNumstatZ", () => {
  it("parses plain entries", () => {
    assert.deepEqual(parseNumstatZ("12\t4\tsrc/a.ts\0"), [
      { path: "src/a.ts", insertions: 12, deletions: 4 },
    ]);
  });

  it("parses the rename form (empty path + two extra tokens)", () => {
    const out = ["1\t1\t", "old.ts", "new.ts", "3\t0\tother.ts", ""].join("\0");
    assert.deepEqual(parseNumstatZ(out), [
      { path: "new.ts", oldPath: "old.ts", insertions: 1, deletions: 1 },
      { path: "other.ts", insertions: 3, deletions: 0 },
    ]);
  });

  it("maps binary '-' counts to null", () => {
    assert.deepEqual(parseNumstatZ("-\t-\timg.png\0"), [
      { path: "img.png", insertions: null, deletions: null },
    ]);
  });
});

describe("mergeChanges", () => {
  it("joins counts, maps statuses, sorts by path", () => {
    const porcelain = parsePorcelainZ(["?? zz.txt", " M b.ts", "R  new.ts", "old.ts", " D gone.ts", "UU clash.ts", ""].join("\0"));
    const numstat = parseNumstatZ(["2\t1\tb.ts", "1\t1\t", "old.ts", "new.ts", "0\t5\tgone.ts", "3\t3\tclash.ts", ""].join("\0"));
    assert.deepEqual(mergeChanges(porcelain, numstat), [
      { path: "b.ts", status: "M", untracked: false, insertions: 2, deletions: 1 },
      { path: "clash.ts", status: "M", untracked: false, insertions: 3, deletions: 3 },
      { path: "gone.ts", status: "D", untracked: false, insertions: 0, deletions: 5 },
      { path: "new.ts", status: "R", untracked: false, insertions: 1, deletions: 1, oldPath: "old.ts" },
      { path: "zz.txt", status: "A", untracked: true, insertions: null, deletions: null },
    ]);
  });

  it("filters .eos/ worktree noise", () => {
    const porcelain = parsePorcelainZ("?? .eos/worktrees/x/f.ts\0 M a.ts\0");
    const merged = mergeChanges(porcelain, []);
    assert.deepEqual(merged.map((f) => f.path), ["a.ts"]);
  });
});

describe("truncatePatch", () => {
  it("passes through under the limit", () => {
    assert.deepEqual(truncatePatch("a\nb\n", 100), { patch: "a\nb\n", truncated: false });
  });

  it("cuts at the last complete line", () => {
    const r = truncatePatch("line1\nline2\nline3\n", 10);
    assert.equal(r.truncated, true);
    assert.equal(r.patch, "line1\n");
  });
});

describe("changedFiles/fileDiff against a real repo", () => {
  let repo: string;

  function git(...args: string[]): void {
    const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  }

  before(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "eos-changes-")));
    spawnSync("git", ["-C", repo, "init"], { encoding: "utf8" });
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(repo, "modified.txt"), "one\ntwo\nthree\n");
    writeFileSync(join(repo, "deleted.txt"), "bye\n");
    writeFileSync(join(repo, "renamed-old.txt"), "same content here\nstable\n");
    writeFileSync(join(repo, "binary.bin"), Buffer.from([0, 1, 2, 255, 0, 3]));
    git("add", "-A");
    git("commit", "-m", "init");
    // Mutations: modify, delete, rename, untracked (with a space), binary change.
    writeFileSync(join(repo, "modified.txt"), "one\nTWO\nthree\nfour\n");
    rmSync(join(repo, "deleted.txt"));
    git("mv", "renamed-old.txt", "renamed-new.txt");
    writeFileSync(join(repo, "fresh file.txt"), "hello\nworld\n");
    writeFileSync(join(repo, "binary.bin"), Buffer.from([255, 254, 0, 1, 0, 9]));
  });

  after(() => {
    try { rmSync(repo, { recursive: true, force: true }); } catch {}
  });

  it("changedFiles reports modify/delete/rename/untracked/binary correctly", async () => {
    const files = await gitInfo.changedFiles(repo);
    const byPath = new Map(files.map((f) => [f.path, f]));

    assert.deepEqual(byPath.get("modified.txt"), {
      path: "modified.txt", status: "M", untracked: false, insertions: 2, deletions: 1,
    });
    assert.equal(byPath.get("deleted.txt")?.status, "D");
    assert.deepEqual(byPath.get("renamed-new.txt"), {
      path: "renamed-new.txt", oldPath: "renamed-old.txt", status: "R", untracked: false, insertions: 0, deletions: 0,
    });
    assert.deepEqual(byPath.get("fresh file.txt"), {
      path: "fresh file.txt", status: "A", untracked: true, insertions: null, deletions: null,
    });
    assert.deepEqual(byPath.get("binary.bin"), {
      path: "binary.bin", status: "M", untracked: false, insertions: null, deletions: null,
    });
  });

  it("fileDiff returns a unified patch for tracked changes", async () => {
    const r = await gitInfo.fileDiff(repo, "modified.txt");
    assert.equal(r.binary, false);
    assert.equal(r.truncated, false);
    assert.match(r.patch, /^@@ /m);
    assert.match(r.patch, /^-two$/m);
    assert.match(r.patch, /^\+TWO$/m);
  });

  it("fileDiff synthesizes an all-add patch for untracked files (--no-index exit-1 path)", async () => {
    const r = await gitInfo.fileDiff(repo, "fresh file.txt");
    assert.match(r.patch, /^\+hello$/m);
    assert.match(r.patch, /^\+world$/m);
  });

  it("fileDiff flags binary files", async () => {
    const r = await gitInfo.fileDiff(repo, "binary.bin");
    assert.equal(r.binary, true);
    assert.equal(r.patch, "");
  });

  it("fileDiff shows deletions for deleted files", async () => {
    const r = await gitInfo.fileDiff(repo, "deleted.txt");
    assert.match(r.patch, /^-bye$/m);
  });

  it("changedFiles returns [] for a non-repo directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eos-norepo-"));
    try {
      assert.deepEqual(await gitInfo.changedFiles(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Base-aware diff: a worktree agent that COMMITS must not look "clean" — the
// fork point (merge-base vs the source checkout) becomes the diff base.
describe("base-aware diff (worktree fork point)", () => {
  let src: string;
  let wt: string;

  function git(cwd: string, ...args: string[]): { code: number; out: string } {
    const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
    return { code: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? "") };
  }

  before(() => {
    src = realpathSync(mkdtempSync(join(tmpdir(), "eos-base-src-")));
    assert.equal(git(src, "init", "-b", "main").code, 0);
    git(src, "config", "user.email", "t@t.t");
    git(src, "config", "user.name", "t");
    git(src, "config", "commit.gpgsign", "false");
    writeFileSync(join(src, "a.txt"), "one\ntwo\n");
    git(src, "add", "-A");
    assert.equal(git(src, "commit", "-m", "init").code, 0);
    wt = join(src, ".eos", "worktrees", "eos-base-w1");
    assert.equal(git(src, "worktree", "add", wt, "-b", "eos-base-w1").code, 0);
    wt = realpathSync(wt);
    // Committed change + uncommitted change + untracked file in the worktree.
    writeFileSync(join(wt, "a.txt"), "ONE\ntwo\n");
    git(wt, "commit", "-aqm", "edit a");
    writeFileSync(join(wt, "b.txt"), "newfile\n");
    git(wt, "add", "b.txt");
    git(wt, "commit", "-qm", "add b");
    writeFileSync(join(wt, "b.txt"), "newfile\nmore\n");
    writeFileSync(join(wt, "untracked.txt"), "u\n");
  });

  after(() => {
    try { rmSync(src, { recursive: true, force: true }); } catch {}
  });

  it("mergeBase finds the fork point", async () => {
    const base = await gitInfo.mergeBase(wt, src);
    assert.ok(base);
    assert.equal(base, git(src, "rev-parse", "HEAD").out.trim());
  });

  it("HEAD-only diff misses committed work; base diff includes it; untracked always counts", async () => {
    const headOnly = await gitInfo.diffShortStat(wt);
    assert.equal(headOnly.files, 2); // uncommitted edit to b.txt + untracked.txt
    const base = await gitInfo.mergeBase(wt, src);
    const full = await gitInfo.diffShortStat(wt, base!);
    // a.txt (committed) + b.txt (committed+uncommitted) + untracked.txt
    assert.equal(full.files, 3);
    assert.ok(full.insertions >= 3);
  });

  it("untracked-only worktree is not reported clean", async () => {
    const wt2 = join(src, ".eos", "worktrees", "eos-base-w2");
    assert.equal(git(src, "worktree", "add", wt2, "-b", "eos-base-w2").code, 0);
    try {
      writeFileSync(join(wt2, "brand-new.md"), "hello\n");
      const base = await gitInfo.mergeBase(wt2, src);
      const stat = await gitInfo.diffShortStat(realpathSync(wt2), base!);
      assert.equal(stat.files, 1);
      assert.equal(stat.insertions, 0); // line counts unknown for untracked
    } finally {
      git(src, "worktree", "remove", "--force", wt2);
      git(src, "branch", "-D", "eos-base-w2");
    }
  });

  it("unpushedCommits lists @{u}..HEAD newest first; no upstream → []", async () => {
    // src has no upstream — must degrade to empty, not throw.
    assert.deepEqual(await gitInfo.unpushedCommits(src), []);

    const cloneBase = mkdtempSync(join(tmpdir(), "eos-unpushed-"));
    const clone = join(cloneBase, "clone");
    try {
      assert.equal(git(src, "clone", "-q", src, clone).code, 0);
      git(clone, "config", "user.email", "t@t.t");
      git(clone, "config", "user.name", "tester");
      git(clone, "config", "commit.gpgsign", "false");
      writeFileSync(join(clone, "p1.txt"), "1\n");
      git(clone, "add", "-A");
      assert.equal(git(clone, "commit", "-qm", "feat: first unpushed").code, 0);
      writeFileSync(join(clone, "p2.txt"), "2\n");
      git(clone, "add", "-A");
      assert.equal(git(clone, "commit", "-qm", "fix: second unpushed").code, 0);

      const commits = await gitInfo.unpushedCommits(clone);
      assert.equal(commits.length, 2);
      assert.equal(commits[0].subject, "fix: second unpushed");
      assert.equal(commits[1].subject, "feat: first unpushed");
      assert.equal(commits[0].author, "tester");
      assert.ok(commits[0].ts > 0);
      assert.match(commits[0].sha, /^[0-9a-f]{7,}$/);

      // Detail of the newest commit: per-file list + totals + body.
      const detail = await gitInfo.commitDetail(clone, commits[0].sha);
      assert.ok(detail);
      assert.equal(detail.subject, "fix: second unpushed");
      assert.equal(detail.files.length, 1);
      assert.equal(detail.files[0].path, "p2.txt");
      assert.equal(detail.files[0].status, "A");
      assert.equal(detail.insertions, 1);
      assert.equal(await gitInfo.commitDetail(clone, "deadbeef"), null);
    } finally {
      rmSync(cloneBase, { recursive: true, force: true });
    }
  });

  it("does not count the in-repo .eos worktree dir as a user change", async () => {
    // src hosts worktrees under .eos/ and has NO .gitignore entry for
    // it (mirrors a user repo that never ignored it) — the source checkout
    // must still read clean.
    const stat = await gitInfo.diffShortStat(src);
    assert.equal(stat.files, 0);
  });

  it("changedFiles with base lists committed, uncommitted and untracked", async () => {
    const base = await gitInfo.mergeBase(wt, src);
    const files = await gitInfo.changedFiles(wt, base!);
    const byPath = new Map(files.map((f) => [f.path, f]));
    assert.equal(byPath.get("a.txt")?.status, "M");
    assert.equal(byPath.get("a.txt")?.untracked, false);
    assert.equal(byPath.get("b.txt")?.status, "A");
    assert.equal(byPath.get("untracked.txt")?.untracked, true);
  });

  it("fileDiff with base shows the committed change", async () => {
    const base = await gitInfo.mergeBase(wt, src);
    const r = await gitInfo.fileDiff(wt, "a.txt", undefined, base!);
    assert.match(r.patch, /^-one$/m);
    assert.match(r.patch, /^\+ONE$/m);
  });

  it("fullDiff + attachPatches embeds the same patch fileDiff serves", async () => {
    const base = await gitInfo.mergeBase(wt, src);
    const [files, full] = await Promise.all([
      gitInfo.changedFiles(wt, base!),
      gitInfo.fullDiff(wt, base!),
    ]);
    assert.ok(full);
    attachPatches(files, full!, 256 * 1024, 2 * 1024 * 1024);
    const a = files.find((f) => f.path === "a.txt");
    assert.match(a!.patch!, /^\+ONE$/m);
    assert.equal(a!.truncated, false);
    // Untracked files have no tree-diff section — they stay lazy.
    const u = files.find((f) => f.untracked);
    assert.equal(u!.patch, undefined);
  });
});

describe("splitUnifiedDiff", () => {
  const section = (path: string, body: string) =>
    `diff --git a/${path} b/${path}\nindex 111..222 100644\n--- a/${path}\n+++ b/${path}\n${body}`;

  it("splits a multi-file diff keyed by path", () => {
    const diff = section("src/a.ts", "@@ -1 +1 @@\n-x\n+y\n") + section("b.txt", "@@ -1 +1 @@\n-1\n+2\n");
    const m = splitUnifiedDiff(diff);
    assert.deepEqual([...m.keys()].sort(), ["b.txt", "src/a.ts"]);
    assert.match(m.get("src/a.ts")!, /^diff --git a\/src\/a\.ts/);
    assert.match(m.get("b.txt")!, /\+2\n$/);
  });

  it("keys deletions on the old path", () => {
    const diff = "diff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\n--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n";
    assert.ok(splitUnifiedDiff(diff).has("gone.txt"));
  });

  it("keys renames on the new path via `rename to`", () => {
    const diff = "diff --git a/old name.ts b/new name.ts\nsimilarity index 90%\nrename from old name.ts\nrename to new name.ts\n--- a/old name.ts\n+++ b/new name.ts\n@@ -1 +1 @@\n-a\n+b\n";
    assert.ok(splitUnifiedDiff(diff).has("new name.ts"));
  });

  it("resolves binary sections from the ambiguous header (spaces included)", () => {
    const diff = "diff --git a/img dir/p.png b/img dir/p.png\nindex 111..222 100644\nBinary files a/img dir/p.png and b/img dir/p.png differ\n";
    assert.ok(splitUnifiedDiff(diff).has("img dir/p.png"));
  });

  it("unquotes git-quoted paths (octal escapes are UTF-8 bytes)", () => {
    const diff = 'diff --git "a/\\303\\244.txt" "b/\\303\\244.txt"\n--- "a/\\303\\244.txt"\n+++ "b/\\303\\244.txt"\n@@ -1 +1 @@\n-a\n+b\n';
    assert.ok(splitUnifiedDiff(diff).has("ä.txt"));
  });

  it("does not mistake an added '++ ' line for a file header", () => {
    const diff = section("a.txt", "@@ -1 +1,2 @@\n x\n+++ not a header\n") + section("b.txt", "@@ -1 +1 @@\n-1\n+2\n");
    const m = splitUnifiedDiff(diff);
    assert.equal(m.size, 2);
    assert.match(m.get("a.txt")!, /\+\+\+ not a header/);
  });
});

describe("attachPatches", () => {
  const mkFile = (path: string, untracked = false) =>
    ({ path, status: "M", untracked, insertions: 1, deletions: 1 }) as Parameters<typeof attachPatches>[0][number];
  const section = (path: string, body: string) =>
    `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${body}`;

  it("embeds patches and flags binaries", () => {
    const files = [mkFile("a.txt"), mkFile("img.png")];
    const diff = section("a.txt", "@@ -1 +1 @@\n-x\n+y\n")
      + "diff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ\n";
    attachPatches(files, diff, 1024, 4096);
    assert.match(files[0].patch!, /\+y/);
    assert.equal(files[0].binary, false);
    assert.equal(files[1].binary, true);
    assert.equal(files[1].patch, "");
  });

  it("skips untracked files", () => {
    const files = [mkFile("new.txt", true)];
    attachPatches(files, section("new.txt", "@@ -0,0 +1 @@\n+hi\n"), 1024, 4096);
    assert.equal(files[0].patch, undefined);
  });

  it("truncates oversized files at the per-file cap", () => {
    const files = [mkFile("big.txt")];
    const body = "@@ -1 +1,200 @@\n" + "+line\n".repeat(200);
    attachPatches(files, section("big.txt", body), 256, 4096);
    assert.equal(files[0].truncated, true);
    assert.ok(Buffer.byteLength(files[0].patch!, "utf8") <= 256);
  });

  it("skips files past the total budget so lazy loading serves them whole", () => {
    const files = [mkFile("a.txt"), mkFile("b.txt")];
    const body = "@@ -1 +1,20 @@\n" + "+x\n".repeat(20);
    const diff = section("a.txt", body) + section("b.txt", body);
    const oneSection = Buffer.byteLength(section("a.txt", body), "utf8");
    attachPatches(files, diff, 1024, oneSection + 10);
    assert.ok(files[0].patch);
    assert.equal(files[1].patch, undefined);
    assert.equal(files[1].truncated, undefined);
  });
});

describe("unborn repo (git init, no commits yet)", () => {
  let repo: string;
  let plainDir: string;

  before(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "eos-unborn-")));
    spawnSync("git", ["-C", repo, "init", "-b", "main"], { encoding: "utf8" });
    writeFileSync(join(repo, "fresh.txt"), "hello\n");
    plainDir = realpathSync(mkdtempSync(join(tmpdir(), "eos-nogit-")));
  });

  after(() => {
    try { rmSync(repo, { recursive: true, force: true }); } catch {}
    try { rmSync(plainDir, { recursive: true, force: true }); } catch {}
  });

  it("isRepo is true even though branch listing and HEAD are empty", async () => {
    assert.equal(await gitInfo.isRepo(repo), true);
    assert.deepEqual(await gitInfo.listBranches(repo), []);
  });

  it("isRepo is false for a plain directory", async () => {
    assert.equal(await gitInfo.isRepo(plainDir), false);
  });

  it("currentBranch resolves the unborn branch name", async () => {
    assert.equal(await gitInfo.currentBranch(repo), "main");
  });

  it("diffShortStat still counts untracked files when HEAD doesn't resolve", async () => {
    const stat = await gitInfo.diffShortStat(repo);
    assert.equal(stat.files, 1);
  });
});
