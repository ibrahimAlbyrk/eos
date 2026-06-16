import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { childProcessGitInfo } from "../git/ChildProcessGitInfo.ts";

function git(cwd: string, args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "recent-checkouts-"));
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "t@t"]);
  git(repo, ["config", "user.name", "t"]);
  writeFileSync(join(repo, "a.txt"), "x\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

test("recentCheckouts returns checkout targets most-recent-first, de-duplicated", async () => {
  git(repo, ["branch", "feature-a"]);
  git(repo, ["branch", "feature-b"]);
  git(repo, ["checkout", "-q", "feature-a"]);
  git(repo, ["checkout", "-q", "feature-b"]);
  git(repo, ["checkout", "-q", "main"]);
  git(repo, ["checkout", "-q", "feature-a"]); // revisit — must collapse to one entry

  assert.deepEqual(await childProcessGitInfo.recentCheckouts(repo), ["feature-a", "main", "feature-b"]);
});

test("recentCheckouts is empty on a fresh repo with no checkouts", async () => {
  assert.deepEqual(await childProcessGitInfo.recentCheckouts(repo), []);
});

test("recentCheckouts is empty (not throwing) outside a git repo", async () => {
  const nonRepo = mkdtempSync(join(tmpdir(), "non-repo-"));
  try {
    assert.deepEqual(await childProcessGitInfo.recentCheckouts(nonRepo), []);
  } finally {
    rmSync(nonRepo, { recursive: true, force: true });
  }
});
