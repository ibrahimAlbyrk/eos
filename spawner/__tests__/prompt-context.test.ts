import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildSystemPromptFile } from "../prompt-context.ts";

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "prompt-context-test-"));
}

const WT = {
  repoRoot: "/Users/u/project",
  worktreeDir: "/Users/u/project/.claude-mgr/worktrees/cm-fix-w1-abc",
  branch: "cm-fix-w1-abc",
  cwd: "/Users/u/project/.claude-mgr/worktrees/cm-fix-w1-abc",
};

test("non-worktree spawn returns the static prompt path unchanged", () => {
  const out = buildSystemPromptFile({
    staticPromptFile: "/some/static.md",
    wt: { repoRoot: null, worktreeDir: null, branch: null, cwd: "/tmp/x" },
    tmpDir: "/unused",
    name: "w1",
    workerId: "w-1",
  });
  assert.equal(out, "/some/static.md");
});

test("non-worktree spawn without static prompt returns undefined", () => {
  const out = buildSystemPromptFile({
    staticPromptFile: undefined,
    wt: { repoRoot: null, worktreeDir: null, branch: null, cwd: "/tmp/x" },
    tmpDir: "/unused",
    name: "w1",
    workerId: "w-1",
  });
  assert.equal(out, undefined);
});

test("worktree spawn synthesizes environment section with literal facts", () => {
  const tmp = makeTmp();
  try {
    const out = buildSystemPromptFile({
      staticPromptFile: undefined,
      wt: WT,
      tmpDir: tmp,
      name: "fix",
      workerId: "w-1",
    });
    assert.equal(out, join(tmp, "system-prompt.md"));
    const content = readFileSync(out!, "utf8");
    assert.match(content, /# Environment/);
    assert.match(content, /isolation: worktree/);
    assert.ok(content.includes(WT.worktreeDir));
    assert.ok(content.includes(WT.branch));
    assert.ok(content.includes(WT.repoRoot));
    assert.match(content, /Handover: branch cm-fix-w1-abc/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("worktree spawn appends environment section after static prompt", () => {
  const tmp = makeTmp();
  try {
    const staticPath = join(tmp, "static.md");
    writeFileSync(staticPath, "# Worker\n\nStatic rules here.\n");
    const out = buildSystemPromptFile({
      staticPromptFile: staticPath,
      wt: WT,
      tmpDir: tmp,
      name: "fix",
      workerId: "w-1",
    });
    const content = readFileSync(out!, "utf8");
    assert.ok(content.startsWith("# Worker"));
    assert.ok(content.indexOf("Static rules here.") < content.indexOf("# Environment"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("unreadable static prompt still ships the environment section", () => {
  const tmp = makeTmp();
  try {
    const out = buildSystemPromptFile({
      staticPromptFile: join(tmp, "missing.md"),
      wt: WT,
      tmpDir: tmp,
      name: "fix",
      workerId: undefined,
    });
    const content = readFileSync(out!, "utf8");
    assert.match(content, /# Environment/);
    assert.match(content, /- agent: fix\n/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
