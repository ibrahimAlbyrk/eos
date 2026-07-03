// setupWorktree carry-uncommitted behavior. Real git repos in a temp dir — the
// mechanism is pure git plumbing, so a stub would prove nothing. Each test gets
// its own repo so the source's dirty state never leaks across cases.

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { setupWorktree } from "../worktree.ts";

const repos: string[] = [];

function git(cwd: string, ...args: string[]): { code: number; out: string } {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return { code: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

function freshRepo(): { repo: string; head: string } {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "eos-carry-")));
  repos.push(repo);
  assert.equal(git(repo, "init", "-b", "main").code, 0);
  git(repo, "config", "user.email", "t@t.t");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "tracked.txt"), "base\n");
  git(repo, "add", "tracked.txt");
  assert.equal(git(repo, "commit", "-m", "init").code, 0);
  const head = git(repo, "rev-parse", "HEAD").out.trim();
  return { repo, head };
}

function dirty(repo: string): void {
  writeFileSync(join(repo, "tracked.txt"), "base\nmodified\n");       // unstaged modification
  writeFileSync(join(repo, "staged.txt"), "staged\n");
  git(repo, "add", "staged.txt");                                     // staged new file
  writeFileSync(join(repo, "untracked.txt"), "untracked\n");          // untracked, not ignored
  // Gitignored + NOT a hydration target (hydration only ever clones
  // node_modules / .env), so its absence proves the carry snapshot — not
  // hydration — respected .gitignore.
  writeFileSync(join(repo, ".gitignore"), "*.log\n");
  writeFileSync(join(repo, "ignored.log"), "ignore me\n");
}

function spec(repo: string, branch: string, carryUncommitted: boolean) {
  return {
    worktreeFrom: repo,
    cwd: undefined,
    name: "carry-test",
    branch,
    worktreeDir: undefined,
    attach: false,
    hydrateEnv: false,
    carryUncommitted,
  };
}

after(() => {
  for (const r of repos) { try { rmSync(r, { recursive: true, force: true }); } catch {} }
});

describe("setupWorktree carry-uncommitted", () => {
  it("forks the worktree from a snapshot of the source's uncommitted work", async () => {
    const { repo, head } = freshRepo();
    dirty(repo);

    const ctx = await setupWorktree(spec(repo, "feat", true), () => {});
    const wt = ctx.worktreeDir!;
    assert.ok(wt, "worktreeDir set");

    // Content is present: modified tracked + staged + untracked all carried.
    assert.match(readFileSync(join(wt, "tracked.txt"), "utf8"), /modified/);
    assert.ok(existsSync(join(wt, "staged.txt")), "staged file carried");
    assert.ok(existsSync(join(wt, "untracked.txt")), "untracked file carried");
    // Gitignored stays out: `git add -A` in the snapshot respects .gitignore.
    assert.equal(existsSync(join(wt, "ignored.log")), false, "gitignored not carried");

    // Worktree boots clean: the WIP is the fork base, not uncommitted edits.
    assert.equal(git(wt, "status", "--porcelain").out.trim(), "", "worktree clean at birth");

    // Fork base is the WIP commit (not the source HEAD), so /changes is agent-only.
    assert.ok(ctx.forkBaseSha && ctx.forkBaseSha !== head, "fork base is the snapshot commit");
    assert.equal(git(wt, "rev-parse", "HEAD").out.trim(), ctx.forkBaseSha);
    assert.equal(git(wt, "diff", ctx.forkBaseSha!).out.trim(), "", "agent-only diff empty at birth");

    // The source checkout's index/worktree was never touched.
    const srcStatus = git(repo, "status", "--porcelain").out;
    assert.match(srcStatus, / M tracked\.txt/);
    assert.match(srcStatus, /A {2}staged\.txt/);
    assert.match(srcStatus, /\?\? untracked\.txt/);
  });

  it("forks clean from HEAD when carry is disabled", async () => {
    const { repo, head } = freshRepo();
    dirty(repo);

    const ctx = await setupWorktree(spec(repo, "feat", false), () => {});
    const wt = ctx.worktreeDir!;

    assert.doesNotMatch(readFileSync(join(wt, "tracked.txt"), "utf8"), /modified/);
    assert.equal(existsSync(join(wt, "untracked.txt")), false);
    assert.equal(ctx.forkBaseSha, head, "fork base is the source HEAD");
  });

  it("forks clean from HEAD when carry is enabled but the source is clean", async () => {
    const { repo, head } = freshRepo();

    const ctx = await setupWorktree(spec(repo, "feat", true), () => {});
    assert.equal(ctx.forkBaseSha, head, "no snapshot when nothing is dirty");
    assert.equal(git(ctx.worktreeDir!, "status", "--porcelain").out.trim(), "");
  });
});
