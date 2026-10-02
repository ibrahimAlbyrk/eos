import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createFsScratchWorkspaces } from "../filesystem/FsScratchWorkspaces.ts";
import { encodeCwd } from "../../../core/src/domain/claude-paths.ts";

let base: string;
let root: string;
let claudeProjectsDir: string;

before(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "eos-scratch-")));
  root = join(base, "scratch");
  claudeProjectsDir = join(base, "claude-projects");
});

after(() => {
  try { rmSync(base, { recursive: true, force: true }); } catch {}
});

describe("FsScratchWorkspaces", () => {
  it("create makes <root>/<id> a git repo with a HEAD commit, and list sees it", async () => {
    const scratch = createFsScratchWorkspaces({ root, claudeProjectsDir });
    const dir = await scratch.create("o-abc");
    assert.equal(dir, join(root, "o-abc"));
    const head = spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" });
    assert.equal(head.status, 0, head.stderr);
    assert.deepEqual(scratch.list(), [dir]);
  });

  it("remove deletes the folder and Claude's data for it and its sub-agent worktrees only", async () => {
    const scratch = createFsScratchWorkspaces({ root, claudeProjectsDir });
    const dir = await scratch.create("o-del");
    const encoded = encodeCwd(realpathSync(dir));
    const own = join(claudeProjectsDir, encoded);
    const child = join(claudeProjectsDir, `${encoded}--eos-worktrees-eos-w-1`);
    const sibling = join(claudeProjectsDir, `${encoded}x`);
    for (const d of [own, child, sibling]) mkdirSync(d, { recursive: true });

    await scratch.remove(dir);

    assert.equal(existsSync(dir), false);
    assert.equal(existsSync(own), false);
    assert.equal(existsSync(child), false);
    assert.equal(existsSync(sibling), true);
  });

  it("remove ignores anything that is not directly under the root", async () => {
    const scratch = createFsScratchWorkspaces({ root, claudeProjectsDir });
    const outside = join(base, "keep-me");
    const nested = join(root, "o-keep", "inner");
    mkdirSync(outside, { recursive: true });
    mkdirSync(nested, { recursive: true });

    await scratch.remove(outside);
    await scratch.remove(nested);
    await scratch.remove(root);

    assert.equal(existsSync(outside), true);
    assert.equal(existsSync(nested), true);
  });
});
