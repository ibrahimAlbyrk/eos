import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { parsePorcelainZ, parseNumstatZ, mergeChanges, truncatePatch } from "../git/changes-parse.ts";
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

  it("filters .claude-mgr/ worktree noise", () => {
    const porcelain = parsePorcelainZ("?? .claude-mgr/worktrees/x/f.ts\0 M a.ts\0");
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
    repo = realpathSync(mkdtempSync(join(tmpdir(), "cm-changes-")));
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
    const dir = mkdtempSync(join(tmpdir(), "cm-norepo-"));
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
    src = realpathSync(mkdtempSync(join(tmpdir(), "cm-base-src-")));
    assert.equal(git(src, "init", "-b", "main").code, 0);
    git(src, "config", "user.email", "t@t.t");
    git(src, "config", "user.name", "t");
    git(src, "config", "commit.gpgsign", "false");
    writeFileSync(join(src, "a.txt"), "one\ntwo\n");
    git(src, "add", "-A");
    assert.equal(git(src, "commit", "-m", "init").code, 0);
    wt = join(src, ".claude-mgr", "worktrees", "cm-base-w1");
    assert.equal(git(src, "worktree", "add", wt, "-b", "cm-base-w1").code, 0);
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
    const wt2 = join(src, ".claude-mgr", "worktrees", "cm-base-w2");
    assert.equal(git(src, "worktree", "add", wt2, "-b", "cm-base-w2").code, 0);
    try {
      writeFileSync(join(wt2, "brand-new.md"), "hello\n");
      const base = await gitInfo.mergeBase(wt2, src);
      const stat = await gitInfo.diffShortStat(realpathSync(wt2), base!);
      assert.equal(stat.files, 1);
      assert.equal(stat.insertions, 0); // line counts unknown for untracked
    } finally {
      git(src, "worktree", "remove", "--force", wt2);
      git(src, "branch", "-D", "cm-base-w2");
    }
  });

  it("does not count the in-repo .claude-mgr worktree dir as a user change", async () => {
    // src hosts worktrees under .claude-mgr/ and has NO .gitignore entry for
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
});
