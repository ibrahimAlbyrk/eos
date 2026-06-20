import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createChildProcessBranchMerge } from "../git/ChildProcessBranchMerge.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

let base: string;
let repo: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "branch-merge-"));
  repo = join(base, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "t@t"]);
  git(repo, ["config", "user.name", "t"]);
  writeFileSync(join(repo, "s.txt"), "l1\nl2\nl3\n");
  writeFileSync(join(repo, "a.txt"), "aaa\n");
  writeFileSync(join(repo, "b.txt"), "bbb\n");
  writeFileSync(join(repo, ".gitignore"), ".eos/\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  mkdirSync(join(repo, ".eos", "worktrees"), { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

interface Ref { repoRoot: string; worktreeDir: string | null; branch: string; workerId: string }

// A worker = a worktree on its own branch with UNCOMMITTED edits (workers don't
// auto-commit; the snapshot captures the dirty worktree).
function worker(name: string, edits: Record<string, string>): Ref {
  const wt = join(repo, ".eos", "worktrees", name);
  git(repo, ["worktree", "add", "-q", wt, "-b", name]);
  for (const [f, content] of Object.entries(edits)) writeFileSync(join(wt, f), content);
  return { repoRoot: repo, worktreeDir: wt, branch: name, workerId: `w-${name}` };
}

function merger() {
  let t = 1_000;
  return createChildProcessBranchMerge({ now: () => t++ });
}

const headOf = (): string => git(repo, ["rev-parse", "HEAD"]).trim();
const statusOf = (file: string): string =>
  git(repo, ["status", "--porcelain"]).split("\n").find((l) => l.includes(file)) ?? "";

test("disjoint workers merge cleanly into the checkout, HEAD untouched", async () => {
  const head0 = headOf();
  const w1 = worker("eos-w1", { "a.txt": "aaa\nW1\n" });
  const w2 = worker("eos-w2", { "b.txt": "bbb\nW2\n" });

  const res = await merger().mergeAll(repo, [w1, w2]);

  assert.equal(res.ok, true);
  assert.equal(res.conflictedFiles.length, 0);
  assert.deepEqual(res.results.map((r) => r.outcome).sort(), ["merged", "merged"]);
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "aaa\nW1\n");
  assert.equal(readFileSync(join(repo, "b.txt"), "utf8"), "bbb\nW2\n");
  assert.ok(!existsSync(join(repo, ".git", "MERGE_HEAD")), "no merge state");
  assert.equal(headOf(), head0, "nothing committed");
});

test("two workers editing the same lines → first merges, second is a real UU conflict", async () => {
  const w1 = worker("eos-w1", { "s.txt": "W1\nl2\nl3\n", "a.txt": "aaa\nW1\n" });
  const w3 = worker("eos-w3", { "s.txt": "W3\nl2\nl3\n", "b.txt": "bbb\nW3\n" });

  const res = await merger().mergeAll(repo, [w1, w3]);

  assert.equal(res.ok, true);
  assert.equal(res.results.find((r) => r.workerId === "w-eos-w1")?.outcome, "merged");
  assert.equal(res.results.find((r) => r.workerId === "w-eos-w3")?.outcome, "conflicted");
  assert.ok(res.conflictedFiles.includes("s.txt"));

  const s = readFileSync(join(repo, "s.txt"), "utf8");
  assert.match(s, /<<<<<<</);
  assert.match(s, />>>>>>>/);
  assert.match(s, /W1/);
  assert.match(s, /W3/);

  // The resolver keys on the canonical unmerged porcelain codes — must be UU.
  assert.ok(statusOf("s.txt").startsWith("UU"), `expected UU, got: "${statusOf("s.txt")}"`);
  // Both workers' disjoint files still landed.
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "aaa\nW1\n");
  assert.equal(readFileSync(join(repo, "b.txt"), "utf8"), "bbb\nW3\n");
});

test("a third worker conflicting on the same file is reported pending", async () => {
  const w1 = worker("eos-w1", { "s.txt": "W1\nl2\nl3\n" });
  const w3 = worker("eos-w3", { "s.txt": "W3\nl2\nl3\n" });
  const w4 = worker("eos-w4", { "s.txt": "W4\nl2\nl3\n" });

  const res = await merger().mergeAll(repo, [w1, w3, w4]);

  const byId = Object.fromEntries(res.results.map((r) => [r.workerId, r.outcome]));
  assert.equal(byId["w-eos-w1"], "merged");
  assert.deepEqual([byId["w-eos-w3"], byId["w-eos-w4"]].sort(), ["conflicted", "pending"]);
});

test("a worker with no changes is skipped", async () => {
  const res = await merger().mergeAll(repo, [worker("eos-w0", {})]);
  assert.equal(res.results[0]!.outcome, "skipped");
  assert.equal(res.conflictedFiles.length, 0);
});

test("refuses when the checkout has local edits to a file the merge touches", async () => {
  writeFileSync(join(repo, "a.txt"), "operator local edit\n");
  const res = await merger().mergeAll(repo, [worker("eos-w1", { "a.txt": "aaa\nW1\n" })]);
  assert.equal(res.ok, false);
  assert.match(res.detail ?? "", /local changes/);
});
