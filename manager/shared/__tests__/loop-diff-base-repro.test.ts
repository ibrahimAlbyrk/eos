// Fix 6d2 — repro test for dossier H3 ("diff/stateHash blind to committed work").
// It creates a real git worktree, COMMITS all its work, and pins how fullDiff and
// worktreeStateHash behave with and WITHOUT the fork base. It documents the
// question; it does NOT change diff-base behavior (the design gates the cure on a
// live repro, which is exactly this).
//
// Finding, asserted below: when a worker's contribution is fully COMMITTED and no
// forkBaseSha is supplied, fullDiff(HEAD) is empty and the state hash is
// indistinguishable from a clean fork — so the judge sees no diff and the
// no-progress detector can read real work as "frozen". Supplying forkBaseSha
// restores both. The source fix (persist + thread forkBaseSha) is therefore the
// correct cure, not a merge-base fallback heuristic.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { childProcessGitInfo as git } from "../../../infra/src/git/ChildProcessGitInfo.ts";
import { worktreeStateHash } from "../worktree-state-hash.ts";

function run(cwd: string, ...args: string[]): { code: number; out: string } {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return { code: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

describe("loop diff/stateHash vs forkBaseSha (H3 repro, Fix 6d2)", () => {
  let src: string;
  let base: string;   // the fork point (src HEAD)
  let committed: string; // worktree with fully-COMMITTED work
  let clean: string;     // a fresh worktree at the same base, no work

  before(() => {
    src = realpathSync(mkdtempSync(join(tmpdir(), "eos-h3-src-")));
    assert.equal(run(src, "init", "-b", "main").code, 0);
    run(src, "config", "user.email", "t@t.t");
    run(src, "config", "user.name", "t");
    run(src, "config", "commit.gpgsign", "false");
    writeFileSync(join(src, "a.txt"), "one\n");
    run(src, "add", "-A");
    assert.equal(run(src, "commit", "-m", "init").code, 0);
    base = run(src, "rev-parse", "HEAD").out.trim();

    committed = join(src, ".eos", "wt-committed");
    assert.equal(run(src, "worktree", "add", committed, "-b", "wt-committed").code, 0);
    committed = realpathSync(committed);
    // All the worker's work is COMMITTED — nothing left uncommitted.
    writeFileSync(join(committed, "feature.txt"), "the new feature\n");
    run(committed, "add", "-A");
    assert.equal(run(committed, "commit", "-m", "add feature").code, 0);

    clean = join(src, ".eos", "wt-clean");
    assert.equal(run(src, "worktree", "add", clean, base).code, 0);
    clean = realpathSync(clean);
  });

  after(() => {
    try { rmSync(src, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("fullDiff blanks committed work without a base, but sees it against the fork base", async () => {
    const noBase = await git.fullDiff(committed);
    assert.equal((noBase ?? "").trim(), ""); // HEAD..worktree is empty — all committed
    const withBase = await git.fullDiff(committed, base);
    assert.ok(withBase && withBase.includes("feature.txt")); // base..worktree shows the real work
  });

  it("worktreeStateHash is blind to committed work without forkBaseSha (the frozen false-positive)", async () => {
    const committedNoBase = await worktreeStateHash(git, { worktreeDir: committed });
    const cleanNoBase = await worktreeStateHash(git, { worktreeDir: clean });
    // Committed work and a clean fork hash IDENTICALLY without a base → the
    // no-progress detector cannot tell them apart (H3 confirmed).
    assert.equal(committedNoBase, cleanNoBase);

    const committedWithBase = await worktreeStateHash(git, { worktreeDir: committed, forkBaseSha: base });
    // Supplying the base makes the committed work visible again → distinct hash.
    assert.notEqual(committedWithBase, committedNoBase);
  });
});
