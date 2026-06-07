import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createChildProcessBranchIntegration } from "../git/ChildProcessBranchIntegration.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

let base: string;
let repo: string;
let worktree: string;
let triesDir: string;

const BRANCH = "cm-test-w1";
const REF = (): { repoRoot: string; worktreeDir: string | null; branch: string; workerId: string } => ({
  repoRoot: repo,
  worktreeDir: worktree,
  branch: BRANCH,
  workerId: "w-1",
});

function integration() {
  return createChildProcessBranchIntegration({ triesDir, now: () => 1_000 });
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "branch-integration-"));
  repo = join(base, "repo");
  triesDir = join(base, "tries");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "t@t"]);
  git(repo, ["config", "user.name", "t"]);
  writeFileSync(join(repo, "a.txt"), "line1\nline2\nline3\n");
  writeFileSync(join(repo, "b.txt"), "b\n");
  // Mirrors documented reality: repos hosting managed worktrees gitignore
  // .claude-mgr/ (it lives inside the repo root).
  writeFileSync(join(repo, ".gitignore"), ".claude-mgr/\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  worktree = join(repo, ".claude-mgr", "worktrees", BRANCH);
  mkdirSync(join(repo, ".claude-mgr", "worktrees"), { recursive: true });
  git(repo, ["worktree", "add", "-q", worktree, "-b", BRANCH]);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

test("apply lands worktree edits as unstaged changes; keep finalizes", async () => {
  writeFileSync(join(worktree, "a.txt"), "line1 EDITED\nline2\nline3\n");
  writeFileSync(join(worktree, "new.txt"), "fresh\n");

  const bi = integration();
  const result = await bi.apply(REF());
  assert.equal(result.ok, true);
  assert.ok(result.ok && result.files.includes("a.txt"));
  assert.ok(result.ok && result.files.includes("new.txt"));

  // Unstaged: working tree changed, index untouched, no merge state.
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "line1 EDITED\nline2\nline3\n");
  assert.equal(readFileSync(join(repo, "new.txt"), "utf8"), "fresh\n");
  const staged = git(repo, ["diff", "--cached", "--name-only"]).trim();
  assert.equal(staged, "");
  assert.ok(!existsSync(join(repo, ".git", "MERGE_HEAD")));

  const active = await bi.activeTry(repo);
  assert.ok(active);
  assert.equal(active.workerId, "w-1");

  const kept = await bi.keep(repo);
  assert.equal(kept.ok, true);
  assert.equal(await bi.activeTry(repo), null);
  // Edits remain after keep.
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "line1 EDITED\nline2\nline3\n");
});

test("discard restores the exact pre-try state including created files", async () => {
  writeFileSync(join(worktree, "a.txt"), "line1 EDITED\nline2\nline3\n");
  writeFileSync(join(worktree, "new.txt"), "fresh\n");

  const bi = integration();
  assert.equal((await bi.apply(REF())).ok, true);
  const discarded = await bi.discard(repo);
  assert.equal(discarded.ok, true);

  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "line1\nline2\nline3\n");
  assert.ok(!existsSync(join(repo, "new.txt")));
  assert.equal(git(repo, ["status", "--porcelain"]).trim(), "");
  assert.equal(await bi.activeTry(repo), null);
});

test("discard refuses per-file when the user edited a touched file mid-try", async () => {
  writeFileSync(join(worktree, "a.txt"), "line1 EDITED\nline2\nline3\n");

  const bi = integration();
  assert.equal((await bi.apply(REF())).ok, true);

  // User edits the applied file during the try.
  writeFileSync(join(repo, "a.txt"), "line1 EDITED BY USER\nline2\nline3\n");

  const discarded = await bi.discard(repo);
  assert.equal(discarded.ok, false);
  assert.ok(!discarded.ok && discarded.reason === "user-edited");
  assert.ok(!discarded.ok && discarded.files?.includes("a.txt"));
  // Nothing reverted.
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "line1 EDITED BY USER\nline2\nline3\n");
  // Try still active — user can resolve and retry.
  assert.ok(await bi.activeTry(repo));
});

test("second apply on the same repo returns active-try", async () => {
  writeFileSync(join(worktree, "a.txt"), "line1 EDITED\nline2\nline3\n");
  const bi = integration();
  assert.equal((await bi.apply(REF())).ok, true);

  const second = await bi.apply({ ...REF(), workerId: "w-2" });
  assert.equal(second.ok, false);
  assert.ok(!second.ok && second.reason === "active-try");
});

test("apply refuses when a touched file is dirty in the user checkout", async () => {
  writeFileSync(join(worktree, "a.txt"), "line1 EDITED\nline2\nline3\n");
  // User's own uncommitted edit to the same file.
  writeFileSync(join(repo, "a.txt"), "line1 user-dirty\nline2\nline3\n");

  const bi = integration();
  const result = await bi.apply(REF());
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.reason === "dirty-files");
  assert.ok(!result.ok && result.files?.includes("a.txt"));
});

test("apply tolerates dirt outside the touched files", async () => {
  writeFileSync(join(worktree, "a.txt"), "line1 EDITED\nline2\nline3\n");
  // Unrelated user edit — must not block.
  writeFileSync(join(repo, "b.txt"), "user wip\n");

  const bi = integration();
  const result = await bi.apply(REF());
  assert.equal(result.ok, true);
  assert.equal(readFileSync(join(repo, "b.txt"), "utf8"), "user wip\n");
});

test("preview reports conflicts without touching the checkout", async () => {
  // Diverge: user commits one change, worktree edits the same line.
  writeFileSync(join(repo, "a.txt"), "line1 USER\nline2\nline3\n");
  git(repo, ["commit", "-aqm", "user change"]);
  writeFileSync(join(worktree, "a.txt"), "line1 WORKER\nline2\nline3\n");

  const bi = integration();
  const preview = await bi.preview(REF());
  assert.equal(preview.supported, true);
  assert.ok(preview.conflicts.includes("a.txt"));
  // Checkout untouched.
  assert.equal(git(repo, ["status", "--porcelain"]).trim(), "");

  const result = await bi.apply(REF());
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.reason === "conflicts");
});

test("preview counts ahead commits and lists touched files", async () => {
  writeFileSync(join(worktree, "a.txt"), "line1 EDITED\nline2\nline3\n");
  git(worktree, ["commit", "-aqm", "worker commit"]);
  writeFileSync(join(worktree, "new.txt"), "fresh\n");

  const bi = integration();
  const preview = await bi.preview(REF());
  assert.equal(preview.supported, true);
  assert.equal(preview.conflicts.length, 0);
  // 1 branch commit + 1 snapshot commit for the uncommitted new.txt.
  assert.ok(preview.ahead >= 1);
  assert.ok(preview.files.includes("a.txt"));
  assert.ok(preview.files.includes("new.txt"));
});

test("apply with nothing to integrate returns nothing-to-apply", async () => {
  const bi = integration();
  const result = await bi.apply(REF());
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.reason === "nothing-to-apply");
});

test("snapshot falls back to branch tip when the worktree dir is gone", async () => {
  writeFileSync(join(worktree, "a.txt"), "line1 EDITED\nline2\nline3\n");
  git(worktree, ["commit", "-aqm", "worker commit"]);
  git(repo, ["worktree", "remove", "--force", worktree]);

  const bi = integration();
  const result = await bi.apply({ ...REF(), worktreeDir: null });
  assert.equal(result.ok, true);
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "line1 EDITED\nline2\nline3\n");
});

test("lockfile change is flagged", async () => {
  writeFileSync(join(worktree, "package-lock.json"), "{}\n");
  const bi = integration();
  const result = await bi.apply(REF());
  assert.equal(result.ok, true);
  assert.ok(result.ok && result.lockfileChanged);
});

test("wasKept: set by keep, never by discard, survives new tries", async () => {
  writeFileSync(join(worktree, "a.txt"), "line1 EDITED\nline2\nline3\n");
  const bi = integration();

  assert.equal(await bi.wasKept({ repoRoot: repo, workerId: "w-1" }), false);

  assert.equal((await bi.apply(REF())).ok, true);
  assert.equal((await bi.keep(repo)).ok, true);
  assert.equal(await bi.wasKept({ repoRoot: repo, workerId: "w-1" }), true);
  assert.equal(await bi.wasKept({ repoRoot: repo, workerId: "w-other" }), false);

  // A different worker's apply+discard must not clear w-1's marker.
  const wt2 = join(repo, ".claude-mgr", "worktrees", "cm-test-w2");
  git(repo, ["worktree", "add", "-q", wt2, "-b", "cm-test-w2"]);
  writeFileSync(join(wt2, "b.txt"), "b CHANGED\n");
  const r2 = await bi.apply({ repoRoot: repo, worktreeDir: wt2, branch: "cm-test-w2", workerId: "w-2" });
  assert.equal(r2.ok, true);
  assert.equal((await bi.discard(repo)).ok, true);
  assert.equal(await bi.wasKept({ repoRoot: repo, workerId: "w-2" }), false);
  assert.equal(await bi.wasKept({ repoRoot: repo, workerId: "w-1" }), true);
});

test("cleanupSnapshot deletes the ref but preserves active try state", async () => {
  writeFileSync(join(worktree, "a.txt"), "line1 EDITED\nline2\nline3\n");
  const bi = integration();
  assert.equal((await bi.apply(REF())).ok, true);

  await bi.cleanupSnapshot({ repoRoot: repo, workerId: "w-1" });
  const refs = git(repo, ["for-each-ref", "refs/eos/snapshots"]).trim();
  assert.equal(refs, "");
  // State + patch survive — discard still works after worker deletion.
  const discarded = await bi.discard(repo);
  assert.equal(discarded.ok, true);
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "line1\nline2\nline3\n");
});
