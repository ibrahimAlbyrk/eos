import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ChokidarGitWatcher } from "../git/ChokidarGitWatcher.ts";
import { childProcessGitInfo as gitInfo } from "../git/ChildProcessGitInfo.ts";
import { systemClock } from "../time/SystemClock.ts";
import type { GitChangeEvent } from "../../../core/src/ports/GitWatcher.ts";

const git = (cwd: string, ...args: string[]): void => {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, timeoutMs = 5000, stepMs = 50): Promise<boolean> {
  const deadline = systemClock.now() + timeoutMs;
  while (systemClock.now() < deadline) {
    if (pred()) return true;
    await sleep(stepMs);
  }
  return pred();
}

function initRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gw-test-")));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t.t");
  git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "1\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "init");
  return dir;
}

describe("ChokidarGitWatcher", () => {
  it("emits dir-keyed, kind-classified events for real git operations", { timeout: 25000 }, async () => {
    const dir = initRepo();
    const events: GitChangeEvent[] = [];
    const w = new ChokidarGitWatcher({
      clock: systemClock,
      sink: (ev) => events.push(ev),
      resolveDirs: (cwd) => gitInfo.gitDirs(cwd),
    });
    try {
      w.watch(dir);
      await sleep(900); // chokidar ready + async resolveDirs

      const kindsSince = (n: number): Set<string> => new Set(events.slice(n).flatMap((e) => e.kinds));

      // Working-tree edit → worktree.
      let mark = events.length;
      writeFileSync(join(dir, "a.txt"), "2\n");
      assert.ok(await waitFor(() => kindsSince(mark).has("worktree")), "expected a worktree event for a file edit");

      // New file + commit → refs (ref move) + index (staging).
      mark = events.length;
      writeFileSync(join(dir, "b.txt"), "x\n");
      git(dir, "add", ".");
      git(dir, "commit", "-qm", "b");
      assert.ok(await waitFor(() => kindsSince(mark).has("refs")), "expected a refs event for a commit");

      // Create + checkout a branch → head (HEAD move) + refs (new ref).
      mark = events.length;
      git(dir, "checkout", "-qb", "feature");
      assert.ok(await waitFor(() => kindsSince(mark).has("head")), "expected a head event for a checkout");

      // Stash → stash (refs/stash ref).
      mark = events.length;
      writeFileSync(join(dir, "a.txt"), "3\n");
      git(dir, "stash", "-q");
      assert.ok(await waitFor(() => kindsSince(mark).has("stash")), "expected a stash event");

      // Every event is keyed by the exact dir passed to watch() — that is what
      // the web's git stores key on, so a mismatch would silently break refresh.
      assert.ok(events.length > 0);
      for (const e of events) assert.equal(e.dir, dir);
    } finally {
      await w.closeAll();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("watches a worktree whose own root contains a .eos segment", { timeout: 25000 }, async () => {
    // Eos worktrees live at <repo>/.eos/worktrees/<branch> — the watch root
    // itself contains ".eos". A bare segment-based ignore matches the root and
    // chokidar v4 suppresses the whole watch; the root-relative ignore must not.
    const repo = initRepo();
    git(repo, "worktree", "add", "-q", ".eos/worktrees/feat", "-b", "feat");
    const wtDir = realpathSync(join(repo, ".eos", "worktrees", "feat"));
    const events: GitChangeEvent[] = [];
    const w = new ChokidarGitWatcher({
      clock: systemClock,
      sink: (ev) => events.push(ev),
      resolveDirs: (cwd) => gitInfo.gitDirs(cwd),
    });
    try {
      assert.ok(wtDir.includes("/.eos/worktrees/feat"), "worktree root must contain a .eos segment");
      w.watch(wtDir);
      await sleep(900); // chokidar ready + async resolveDirs

      const kindsSince = (n: number): Set<string> => new Set(events.slice(n).flatMap((e) => e.kinds));

      // (a) A real edit inside the .eos-rooted worktree still fires worktree.
      let mark = events.length;
      writeFileSync(join(wtDir, "a.txt"), "2\n");
      assert.ok(await waitFor(() => kindsSince(mark).has("worktree")), "expected a worktree event for an edit in the .eos-rooted worktree");
      for (const e of events) assert.equal(e.dir, wtDir);

      // (b) A nested .eos/ or node_modules/ inside the worktree stays ignored.
      mark = events.length;
      mkdirSync(join(wtDir, "node_modules"), { recursive: true });
      writeFileSync(join(wtDir, "node_modules", "dep.txt"), "x\n");
      mkdirSync(join(wtDir, ".eos"), { recursive: true });
      writeFileSync(join(wtDir, ".eos", "child.txt"), "y\n");
      await sleep(700); // > DEBOUNCE_MS — any event would have flushed by now
      assert.equal(kindsSince(mark).size, 0, "nested .eos/ and node_modules/ inside the worktree must be ignored");
    } finally {
      await w.closeAll();
      git(repo, "worktree", "remove", "--force", ".eos/worktrees/feat");
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("emits nothing for a non-git directory", { timeout: 8000 }, async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "gw-nongit-")));
    const events: GitChangeEvent[] = [];
    const w = new ChokidarGitWatcher({
      clock: systemClock,
      sink: (ev) => events.push(ev),
      resolveDirs: (cwd) => gitInfo.gitDirs(cwd),
    });
    try {
      w.watch(dir);
      await sleep(700);
      writeFileSync(join(dir, "file.txt"), "data\n");
      await sleep(700);
      assert.equal(events.length, 0, "a non-repo dir resolves to no git dirs → no watch → no events");
    } finally {
      await w.closeAll();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
