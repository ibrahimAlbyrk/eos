import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileMemoryProvider } from "../memory/FileMemoryProvider.ts";
import type { MemorySource } from "../../../contracts/src/memory.ts";

const roots: string[] = [];
function temp(): string { const d = mkdtempSync(join(tmpdir(), "eos-mem-")); roots.push(d); return d; }
function write(path: string, content: string): void { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, content); }
const noHome = (base: string) => join(base, "nohome");

const claude = (over: Partial<MemorySource> = {}): MemorySource => ({
  id: "claude", label: "CLAUDE.md", userPaths: ["~/.claude/CLAUDE.md"], projectFilenames: ["CLAUDE.md"],
  priority: 0, assumeNativeFor: ["claude-cli"], ...over,
});
const agents = (over: Partial<MemorySource> = {}): MemorySource => ({
  id: "agents", label: "AGENTS.md", userPaths: [], projectFilenames: ["AGENTS.md"],
  priority: 10, assumeNativeFor: [], ...over,
});

afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe("FileMemoryProvider — multi-source CLAUDE.md / AGENTS.md discovery", () => {
  it("reads user (~ expands to the injected home) then project, tagged with source metadata", () => {
    const base = temp();
    const home = join(base, "home");
    const repo = join(base, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    write(join(home, ".claude", "CLAUDE.md"), "USER MEM");
    write(join(repo, "CLAUDE.md"), "PROJECT MEM");

    const out = new FileMemoryProvider([claude()], home).load({ cwd: repo });
    assert.deepEqual(out.docs.map((d) => [d.level, d.sourceId, d.sourceLabel, d.content]), [
      ["user", "claude", "CLAUDE.md", "USER MEM"],
      ["project", "claude", "CLAUDE.md", "PROJECT MEM"],
    ]);
    assert.deepEqual(out.docs[0].nativeFor, ["claude-cli"]);
  });

  it("collects multiple sources at the same dir, grouped per source in source order", () => {
    const base = temp();
    const repo = join(base, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    write(join(repo, "CLAUDE.md"), "C");
    write(join(repo, "AGENTS.md"), "A");

    const out = new FileMemoryProvider([claude({ userPaths: [] }), agents()], noHome(base)).load({ cwd: repo });
    assert.deepEqual(out.docs.map((d) => [d.sourceId, d.content]), [["claude", "C"], ["agents", "A"]]);
  });

  it("walks each source's filename up to the .git root, ordered root → cwd", () => {
    const base = temp();
    const repo = join(base, "repo");
    const sub = join(repo, "pkg", "app");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(sub, { recursive: true });
    write(join(repo, "AGENTS.md"), "ROOT");
    write(join(sub, "AGENTS.md"), "APP");

    const out = new FileMemoryProvider([agents()], noHome(base)).load({ cwd: sub });
    assert.deepEqual(out.docs.map((d) => d.content), ["ROOT", "APP"]);
  });

  it("stops at the .git boundary and treats a .git FILE (worktree) as a boundary", () => {
    const base = temp();
    const wt = join(base, "wt");
    mkdirSync(wt, { recursive: true });
    write(join(base, "CLAUDE.md"), "ABOVE");
    writeFileSync(join(wt, ".git"), "gitdir: /elsewhere\n");
    write(join(wt, "CLAUDE.md"), "WT");

    const out = new FileMemoryProvider([claude({ userPaths: [] })], noHome(base)).load({ cwd: wt });
    assert.deepEqual(out.docs.map((d) => d.content), ["WT"]);
  });

  it("honors an explicit repoRoot bound when there is no .git", () => {
    const base = temp();
    const repo = join(base, "repo");
    const sub = join(repo, "a", "b");
    mkdirSync(sub, { recursive: true });
    write(join(base, "CLAUDE.md"), "ABOVE");
    write(join(repo, "CLAUDE.md"), "ROOT");
    write(join(sub, "CLAUDE.md"), "LEAF");

    const out = new FileMemoryProvider([claude({ userPaths: [] })], noHome(base)).load({ cwd: sub, repoRoot: repo });
    assert.deepEqual(out.docs.map((d) => d.content), ["ROOT", "LEAF"]);
  });

  it("skips whitespace-only and missing files (no docs)", () => {
    const base = temp();
    const repo = join(base, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    write(join(repo, "CLAUDE.md"), "   \n");

    const out = new FileMemoryProvider([claude({ userPaths: [] }), agents()], noHome(base)).load({ cwd: repo });
    assert.deepEqual(out.docs, []);
  });
});
