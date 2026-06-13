import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { childProcessGitInfo } from "../git/ChildProcessGitInfo.ts";
import { childProcessConflictResolution } from "../git/ChildProcessConflictResolution.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}
function tryMerge(cwd: string, branch: string): void {
  try { git(cwd, ["merge", "--no-edit", branch]); } catch { /* conflict → non-zero */ }
}

let base: string;
let repo: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "conflict-"));
  repo = join(base, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "t@t"]);
  git(repo, ["config", "user.name", "t"]);
  writeFileSync(join(repo, "f.txt"), "a\nb\nc\n");
  writeFileSync(join(repo, "g.txt"), "g1\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

test("content conflict: list + sides read, then writeResolved stages the merge", async () => {
  git(repo, ["checkout", "-q", "-b", "feat"]);
  writeFileSync(join(repo, "f.txt"), "a\nX\nc\n");
  git(repo, ["commit", "-qam", "feat"]);
  git(repo, ["checkout", "-q", "main"]);
  writeFileSync(join(repo, "f.txt"), "a\nY\nc\n");
  git(repo, ["commit", "-qam", "main"]);
  tryMerge(repo, "feat");

  const list = await childProcessGitInfo.conflictList(repo);
  assert.deepEqual(list, [{ path: "f.txt", xy: "UU" }]);
  assert.equal(await childProcessGitInfo.conflictCount(repo), 1);

  const content = await childProcessGitInfo.conflictFileContent(repo, "f.txt");
  assert.match(content, /<<<<<<</);
  assert.match(content, />>>>>>>/);

  assert.equal(await childProcessGitInfo.stageContent(repo, "f.txt", 2), "a\nY\nc\n"); // ours (HEAD)
  assert.equal(await childProcessGitInfo.stageContent(repo, "f.txt", 3), "a\nX\nc\n"); // theirs

  await childProcessConflictResolution.writeResolved(repo, "f.txt", "a\nMERGED\nc\n");
  assert.equal(readFileSync(join(repo, "f.txt"), "utf8"), "a\nMERGED\nc\n");
  assert.equal(await childProcessGitInfo.conflictCount(repo), 0);
  // Staged, no longer unmerged: index status letter is M (X column).
  assert.match(git(repo, ["status", "--porcelain", "f.txt"]), /^M/);
});

test("delete conflict: takeSide('theirs') accepts the deletion and stages it", async () => {
  git(repo, ["checkout", "-q", "-b", "feat2"]);
  git(repo, ["rm", "-q", "g.txt"]);
  git(repo, ["commit", "-qm", "delete g"]);
  git(repo, ["checkout", "-q", "main"]);
  writeFileSync(join(repo, "g.txt"), "g1\nMOD\n");
  git(repo, ["commit", "-qam", "modify g"]);
  tryMerge(repo, "feat2");

  const list = await childProcessGitInfo.conflictList(repo);
  assert.equal(list.length, 1);
  assert.equal(list[0].path, "g.txt");
  assert.equal(list[0].xy, "UD"); // modified by us, deleted by them

  await childProcessConflictResolution.takeSide(repo, "g.txt", "theirs", "theirs-deleted");
  assert.equal(existsSync(join(repo, "g.txt")), false);
  assert.equal(await childProcessGitInfo.conflictCount(repo), 0);
});
