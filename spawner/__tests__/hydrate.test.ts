import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { hydrateWorktree, type HydrationItem } from "../../infra/src/git/hydrateWorktree.ts";

function git(args: string[], cwd: string): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
}

function makeRepo(): { root: string; worktree: string } {
  const base = mkdtempSync(join(tmpdir(), "hydrate-test-"));
  const root = join(base, "repo");
  const worktree = join(base, "wt");
  mkdirSync(root, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  git(["init", "-q"], root);
  return { root, worktree };
}

function byPath(items: HydrationItem[], p: string): HydrationItem | undefined {
  return items.find((i) => i.path === p);
}

test("hydrates gitignored node_modules into the worktree", () => {
  const { root, worktree } = makeRepo();
  try {
    writeFileSync(join(root, ".gitignore"), "node_modules\n");
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(root, "node_modules", "pkg", "index.js"), "module.exports = 1;");

    const items = hydrateWorktree({ repoRoot: root, worktreeDir: worktree, includeEnvFiles: false, log: () => {} });

    const nm = byPath(items, "node_modules");
    assert.ok(nm);
    assert.ok(nm.status === "cloned" || nm.status === "copied");
    assert.ok(existsSync(join(worktree, "node_modules", "pkg", "index.js")));
  } finally {
    rmSync(join(root, ".."), { recursive: true, force: true });
  }
});

test("skips node_modules that is NOT gitignored", () => {
  const { root, worktree } = makeRepo();
  try {
    mkdirSync(join(root, "node_modules"), { recursive: true });
    writeFileSync(join(root, "node_modules", "x.js"), "x");

    const items = hydrateWorktree({ repoRoot: root, worktreeDir: worktree, includeEnvFiles: false, log: () => {} });

    const nm = byPath(items, "node_modules");
    assert.ok(nm);
    assert.equal(nm.status, "skipped");
    assert.match(nm.reason ?? "", /not gitignored/);
    assert.ok(!existsSync(join(worktree, "node_modules")));
  } finally {
    rmSync(join(root, ".."), { recursive: true, force: true });
  }
});

test("finds nested node_modules in subpackages", () => {
  const { root, worktree } = makeRepo();
  try {
    writeFileSync(join(root, ".gitignore"), "node_modules\n");
    mkdirSync(join(root, "packages", "web", "node_modules"), { recursive: true });
    writeFileSync(join(root, "packages", "web", "node_modules", "y.js"), "y");

    const items = hydrateWorktree({ repoRoot: root, worktreeDir: worktree, includeEnvFiles: false, log: () => {} });

    const nested = byPath(items, join("packages", "web", "node_modules"));
    assert.ok(nested);
    assert.ok(nested.status === "cloned" || nested.status === "copied");
    assert.ok(existsSync(join(worktree, "packages", "web", "node_modules", "y.js")));
  } finally {
    rmSync(join(root, ".."), { recursive: true, force: true });
  }
});

test(".env files copied only when includeEnvFiles is set", () => {
  const { root, worktree } = makeRepo();
  try {
    writeFileSync(join(root, ".gitignore"), ".env*\n");
    writeFileSync(join(root, ".env"), "SECRET=1");
    writeFileSync(join(root, ".env.local"), "LOCAL=1");

    const without = hydrateWorktree({ repoRoot: root, worktreeDir: worktree, includeEnvFiles: false, log: () => {} });
    assert.equal(byPath(without, ".env"), undefined);
    assert.ok(!existsSync(join(worktree, ".env")));

    const withEnv = hydrateWorktree({ repoRoot: root, worktreeDir: worktree, includeEnvFiles: true, log: () => {} });
    const env = byPath(withEnv, ".env");
    assert.ok(env);
    assert.ok(env.status === "cloned" || env.status === "copied");
    assert.ok(existsSync(join(worktree, ".env")));
    assert.ok(existsSync(join(worktree, ".env.local")));
  } finally {
    rmSync(join(root, ".."), { recursive: true, force: true });
  }
});

test("symlinked node_modules is ignored entirely", () => {
  const { root, worktree } = makeRepo();
  try {
    writeFileSync(join(root, ".gitignore"), "node_modules\n");
    const real = join(root, "..", "real-nm");
    mkdirSync(real, { recursive: true });
    symlinkSync(real, join(root, "node_modules"));

    const items = hydrateWorktree({ repoRoot: root, worktreeDir: worktree, includeEnvFiles: false, log: () => {} });
    assert.equal(byPath(items, "node_modules"), undefined);
    assert.ok(!existsSync(join(worktree, "node_modules")));
  } finally {
    rmSync(join(root, ".."), { recursive: true, force: true });
  }
});
