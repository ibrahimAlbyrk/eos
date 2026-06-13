import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, renameSync, readdirSync } from "node:fs";
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

const BRANCH = "eos-test-w1";
const REF = (): { repoRoot: string; worktreeDir: string | null; branch: string; workerId: string } => ({
  repoRoot: repo,
  worktreeDir: worktree,
  branch: BRANCH,
  workerId: "w-1",
});

function integration() {
  let t = 1_000;
  return createChildProcessBranchIntegration({ triesDir, now: () => t++ });
}

function addWorktree(name: string): string {
  const wt = join(repo, ".eos", "worktrees", name);
  git(repo, ["worktree", "add", "-q", wt, "-b", name]);
  return wt;
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
  // .eos/ (it lives inside the repo root).
  writeFileSync(join(repo, ".gitignore"), ".eos/\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  worktree = join(repo, ".eos", "worktrees", BRANCH);
  mkdirSync(join(repo, ".eos", "worktrees"), { recursive: true });
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

  const active = await bi.activeTries(repo);
  assert.equal(active.length, 1);
  assert.equal(active[0]!.workerId, "w-1");

  const kept = await bi.keep(repo, "w-1");
  assert.equal(kept.ok, true);
  assert.equal((await bi.activeTries(repo)).length, 0);
  // Edits remain after keep.
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "line1 EDITED\nline2\nline3\n");
});

test("discard restores the exact pre-try state including created files", async () => {
  writeFileSync(join(worktree, "a.txt"), "line1 EDITED\nline2\nline3\n");
  writeFileSync(join(worktree, "new.txt"), "fresh\n");

  const bi = integration();
  assert.equal((await bi.apply(REF())).ok, true);
  const discarded = await bi.discard(repo, "w-1");
  assert.equal(discarded.ok, true);

  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "line1\nline2\nline3\n");
  assert.ok(!existsSync(join(repo, "new.txt")));
  assert.equal(git(repo, ["status", "--porcelain"]).trim(), "");
  assert.equal((await bi.activeTries(repo)).length, 0);
});

test("discard refuses per-file when the user edited a touched file mid-try", async () => {
  writeFileSync(join(worktree, "a.txt"), "line1 EDITED\nline2\nline3\n");

  const bi = integration();
  assert.equal((await bi.apply(REF())).ok, true);

  // User edits the applied file during the try.
  writeFileSync(join(repo, "a.txt"), "line1 EDITED BY USER\nline2\nline3\n");

  const discarded = await bi.discard(repo, "w-1");
  assert.equal(discarded.ok, false);
  assert.ok(!discarded.ok && discarded.reason === "user-edited");
  assert.ok(!discarded.ok && discarded.files?.includes("a.txt"));
  // Nothing reverted.
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "line1 EDITED BY USER\nline2\nline3\n");
  // Try still active — user can resolve and retry.
  assert.equal((await bi.activeTries(repo)).length, 1);
});

test("re-apply re-syncs only the worker's new worktree delta", async () => {
  writeFileSync(join(worktree, "a.txt"), "line1 EDITED\nline2\nline3\n");
  writeFileSync(join(worktree, "new.txt"), "fresh\n");
  const bi = integration();
  const first = await bi.apply(REF());
  assert.equal(first.ok, true);
  assert.ok(first.ok && first.files.includes("a.txt") && first.files.includes("new.txt"));

  // Worker keeps working: edits an already-applied file AND adds another.
  writeFileSync(join(worktree, "a.txt"), "line1 FIXED\nline2\nline3\n");
  writeFileSync(join(worktree, "new2.txt"), "second\n");

  const again = await bi.apply(REF());
  assert.equal(again.ok, true);
  // Only the delta is reported — new.txt was unchanged this round.
  assert.ok(again.ok && again.files.includes("a.txt"));
  assert.ok(again.ok && again.files.includes("new2.txt"));
  assert.ok(again.ok && !again.files.includes("new.txt"));
  // Checkout now matches the latest worktree state.
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "line1 FIXED\nline2\nline3\n");
  assert.equal(readFileSync(join(repo, "new2.txt"), "utf8"), "second\n");
  // Still one layer (re-sync updated it in place, did not stack).
  assert.equal((await bi.activeTries(repo)).length, 1);

  // Discard reverses the WHOLE layer back to the pre-try state.
  assert.equal((await bi.discard(repo, "w-1")).ok, true);
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "line1\nline2\nline3\n");
  assert.ok(!existsSync(join(repo, "new.txt")));
  assert.ok(!existsSync(join(repo, "new2.txt")));
  assert.equal(git(repo, ["status", "--porcelain"]).trim(), "");
});

test("re-apply with no new worktree changes returns nothing-to-apply", async () => {
  writeFileSync(join(worktree, "a.txt"), "line1 EDITED\nline2\nline3\n");
  const bi = integration();
  assert.equal((await bi.apply(REF())).ok, true);
  const again = await bi.apply(REF());
  assert.equal(again.ok, false);
  assert.ok(!again.ok && again.reason === "nothing-to-apply");
});

test("re-apply refuses to clobber a file the user edited after applying", async () => {
  writeFileSync(join(worktree, "a.txt"), "line1 EDITED\nline2\nline3\n");
  const bi = integration();
  assert.equal((await bi.apply(REF())).ok, true);

  // User edits the applied file, then the worker also advances it.
  writeFileSync(join(repo, "a.txt"), "line1 USER EDIT\nline2\nline3\n");
  writeFileSync(join(worktree, "a.txt"), "line1 WORKER FIX\nline2\nline3\n");

  const again = await bi.apply(REF());
  assert.equal(again.ok, false);
  assert.ok(!again.ok && again.reason === "dirty-files");
  assert.ok(!again.ok && again.files?.includes("a.txt"));
  // Nothing clobbered.
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "line1 USER EDIT\nline2\nline3\n");
});

test("sync after keep pulls the worker's new changes (kept layer stays syncable)", async () => {
  writeFileSync(join(worktree, "a.txt"), "line1 EDITED\nline2\nline3\n");
  const bi = integration();
  assert.equal((await bi.apply(REF())).ok, true);
  assert.equal((await bi.keep(repo, "w-1")).ok, true);
  // Kept: out of the deck, but the marker persists.
  assert.equal((await bi.activeTries(repo)).length, 0);
  assert.equal(await bi.wasKept({ repoRoot: repo, workerId: "w-1" }), true);
  // Nothing new yet.
  assert.deepEqual(await bi.syncStatus(REF()), { syncable: false, files: [] });

  // Worker fixes a bug after the keep.
  writeFileSync(join(worktree, "a.txt"), "line1 BUGFIX\nline2\nline3\n");
  const s = await bi.syncStatus(REF());
  assert.equal(s.syncable, true);
  assert.ok(s.files.includes("a.txt"));

  // Re-sync brings the fix in; the layer returns to the deck (provisional).
  const resync = await bi.apply(REF());
  assert.equal(resync.ok, true);
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "line1 BUGFIX\nline2\nline3\n");
  assert.equal((await bi.activeTries(repo)).length, 1);
  assert.equal(await bi.wasKept({ repoRoot: repo, workerId: "w-1" }), false);
});

test("cleanupSnapshot finalizes a kept layer (drops it, deletes the ref)", async () => {
  writeFileSync(join(worktree, "a.txt"), "line1 EDITED\nline2\nline3\n");
  const bi = integration();
  assert.equal((await bi.apply(REF())).ok, true);
  assert.equal((await bi.keep(repo, "w-1")).ok, true);
  // Kept layer keeps its ref pinned (so it can still be synced)…
  assert.ok(git(repo, ["for-each-ref", "refs/eos/snapshots"]).includes("w-1"));

  // …until the worker is deleted: the edits stay in the checkout, tracking ends.
  await bi.cleanupSnapshot({ repoRoot: repo, workerId: "w-1" });
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "line1 EDITED\nline2\nline3\n");
  assert.equal(git(repo, ["for-each-ref", "refs/eos/snapshots"]).trim(), "");
  assert.equal(await bi.wasKept({ repoRoot: repo, workerId: "w-1" }), false);
});

test("disjoint tries from two workers stack and resolve in any order", async () => {
  writeFileSync(join(worktree, "a.txt"), "line1 W1\nline2\nline3\n");
  const wt2 = addWorktree("eos-test-w2");
  writeFileSync(join(wt2, "b.txt"), "b W2\n");

  const bi = integration();
  assert.equal((await bi.apply(REF())).ok, true);
  const r2 = await bi.apply({ repoRoot: repo, worktreeDir: wt2, branch: "eos-test-w2", workerId: "w-2" });
  assert.equal(r2.ok, true);

  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "line1 W1\nline2\nline3\n");
  assert.equal(readFileSync(join(repo, "b.txt"), "utf8"), "b W2\n");
  const active = await bi.activeTries(repo);
  assert.deepEqual(active.map((t) => t.workerId), ["w-1", "w-2"]);

  // Discard the BOTTOM layer first — disjoint, so order-free.
  assert.equal((await bi.discard(repo, "w-1")).ok, true);
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "line1\nline2\nline3\n");
  assert.equal(readFileSync(join(repo, "b.txt"), "utf8"), "b W2\n");

  assert.equal((await bi.discard(repo, "w-2")).ok, true);
  assert.equal(git(repo, ["status", "--porcelain"]).trim(), "");
});

test("overlapping clean-merging tries stack; lower discard is blocked until the overlay resolves", async () => {
  writeFileSync(join(worktree, "a.txt"), "line1 W1\nline2\nline3\n");
  const wt2 = addWorktree("eos-test-w2");
  writeFileSync(join(wt2, "a.txt"), "line1\nline2\nline3 W2\n");

  const bi = integration();
  assert.equal((await bi.apply(REF())).ok, true);
  const r2 = await bi.apply({ repoRoot: repo, worktreeDir: wt2, branch: "eos-test-w2", workerId: "w-2" });
  assert.equal(r2.ok, true);
  // Both layers landed in the same file.
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "line1 W1\nline2\nline3 W2\n");

  const blocked = await bi.discard(repo, "w-1");
  assert.equal(blocked.ok, false);
  assert.ok(!blocked.ok && blocked.reason === "blocked-by-overlay");
  assert.ok(!blocked.ok && blocked.detail === "w-2");
  assert.ok(!blocked.ok && blocked.files?.includes("a.txt"));

  // Resolve top, then bottom.
  assert.equal((await bi.discard(repo, "w-2")).ok, true);
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "line1 W1\nline2\nline3\n");
  assert.equal((await bi.discard(repo, "w-1")).ok, true);
  assert.equal(git(repo, ["status", "--porcelain"]).trim(), "");
});

test("keep is tree-neutral for any layer; the overlay above stays discardable", async () => {
  writeFileSync(join(worktree, "a.txt"), "line1 W1\nline2\nline3\n");
  const wt2 = addWorktree("eos-test-w2");
  writeFileSync(join(wt2, "a.txt"), "line1\nline2\nline3 W2\n");

  const bi = integration();
  assert.equal((await bi.apply(REF())).ok, true);
  assert.equal((await bi.apply({ repoRoot: repo, worktreeDir: wt2, branch: "eos-test-w2", workerId: "w-2" })).ok, true);

  // Keep the BOTTOM layer while an overlapping layer sits on top.
  assert.equal((await bi.keep(repo, "w-1")).ok, true);
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "line1 W1\nline2\nline3 W2\n");
  assert.equal(await bi.wasKept({ repoRoot: repo, workerId: "w-1" }), true);

  assert.equal((await bi.discard(repo, "w-2")).ok, true);
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "line1 W1\nline2\nline3\n");
});

test("a second try conflicting with an active layer returns conflicts-with-try", async () => {
  writeFileSync(join(worktree, "a.txt"), "line1 W1\nline2\nline3\n");
  const wt2 = addWorktree("eos-test-w2");
  writeFileSync(join(wt2, "a.txt"), "line1 W2\nline2\nline3\n");

  const bi = integration();
  assert.equal((await bi.apply(REF())).ok, true);
  const r2 = await bi.apply({ repoRoot: repo, worktreeDir: wt2, branch: "eos-test-w2", workerId: "w-2" });
  assert.equal(r2.ok, false);
  assert.ok(!r2.ok && r2.reason === "conflicts-with-try");
  assert.ok(!r2.ok && r2.detail?.includes("w-1"));
  // Nothing changed in the checkout; the first layer is intact.
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "line1 W1\nline2\nline3\n");
  assert.equal((await bi.activeTries(repo)).length, 1);
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
  assert.equal((await bi.keep(repo, "w-1")).ok, true);
  assert.equal(await bi.wasKept({ repoRoot: repo, workerId: "w-1" }), true);
  assert.equal(await bi.wasKept({ repoRoot: repo, workerId: "w-other" }), false);

  // A different worker's apply+discard must not clear w-1's marker.
  const wt2 = addWorktree("eos-test-w2");
  writeFileSync(join(wt2, "b.txt"), "b CHANGED\n");
  const r2 = await bi.apply({ repoRoot: repo, worktreeDir: wt2, branch: "eos-test-w2", workerId: "w-2" });
  assert.equal(r2.ok, true);
  assert.equal((await bi.discard(repo, "w-2")).ok, true);
  assert.equal(await bi.wasKept({ repoRoot: repo, workerId: "w-2" }), false);
  assert.equal(await bi.wasKept({ repoRoot: repo, workerId: "w-1" }), true);
});

test("cleanupSnapshot keeps an active layer's ref pinned, deletes inactive refs", async () => {
  writeFileSync(join(worktree, "a.txt"), "line1 EDITED\nline2\nline3\n");
  const bi = integration();
  assert.equal((await bi.apply(REF())).ok, true);

  // Active layer: the ref stays so later applies can rebuild the stack;
  // state + patch survive — discard still works after worker deletion.
  await bi.cleanupSnapshot({ repoRoot: repo, workerId: "w-1" });
  assert.ok(git(repo, ["for-each-ref", "refs/eos/snapshots"]).includes("w-1"));

  const discarded = await bi.discard(repo, "w-1");
  assert.equal(discarded.ok, true);
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "line1\nline2\nline3\n");
  assert.equal(git(repo, ["for-each-ref", "refs/eos/snapshots"]).trim(), "");

  // No active layer: preview is side-effect free (no longer pins), and cleanup
  // is a safe no-op on an already-absent ref.
  writeFileSync(join(worktree, "a.txt"), "line1 AGAIN\nline2\nline3\n");
  assert.equal((await bi.preview(REF())).supported, true);
  assert.equal(git(repo, ["for-each-ref", "refs/eos/snapshots"]).trim(), "");
  await bi.cleanupSnapshot({ repoRoot: repo, workerId: "w-1" });
  assert.equal(git(repo, ["for-each-ref", "refs/eos/snapshots"]).trim(), "");
});

test("legacy single-try layout (try.json + try.patch) migrates to the stack", async () => {
  writeFileSync(join(worktree, "a.txt"), "line1 EDITED\nline2\nline3\n");
  const bi = integration();
  assert.equal((await bi.apply(REF())).ok, true);

  // Rewrite the on-disk state into the pre-stack layout.
  const dir = join(triesDir, readdirSync(triesDir)[0]!);
  const tries = JSON.parse(readFileSync(join(dir, "tries.json"), "utf8"));
  writeFileSync(join(dir, "try.json"), JSON.stringify(tries[0]));
  rmSync(join(dir, "tries.json"));
  renameSync(join(dir, "w-1.patch"), join(dir, "try.patch"));

  const bi2 = integration();
  const active = await bi2.activeTries(repo);
  assert.equal(active.length, 1);
  assert.equal(active[0]!.workerId, "w-1");
  assert.equal((await bi2.discard(repo, "w-1")).ok, true);
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "line1\nline2\nline3\n");
});
