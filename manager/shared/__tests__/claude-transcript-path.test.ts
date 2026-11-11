import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claudeTranscriptPath } from "../claude-transcript-path.ts";
import { encodeCwd } from "../../../core/src/domain/claude-paths.ts";

const SESSION = "6b75528c-2894-4b99-bf85-ecadc82b8932";

function setup(): { projects: string; cwd: string; started: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "transcript-path-")));
  const projects = join(root, "projects");
  const cwd = join(root, "repo");
  mkdirSync(projects);
  mkdirSync(cwd);
  return { projects, cwd, started: join(projects, encodeCwd(cwd), `${SESSION}.jsonl`) };
}

function write(path: string, mtimeSec: number): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "{}\n");
  utimesSync(path, mtimeSec, mtimeSec);
}

describe("claudeTranscriptPath", () => {
  it("is the starting folder's path while no transcript exists", () => {
    const { projects, cwd, started } = setup();
    assert.equal(claudeTranscriptPath(cwd, SESSION, projects), started);
  });

  it("finds the transcript where the session started", () => {
    const { projects, cwd, started } = setup();
    write(started, 1000);
    assert.equal(claudeTranscriptPath(cwd, SESSION, projects), started);
  });

  it("follows a session whose transcript moved to a worktree's folder", () => {
    const { projects, cwd } = setup();
    const moved = join(projects, `${encodeCwd(cwd)}-2d-perf`, `${SESSION}.jsonl`);
    write(moved, 1000);
    write(join(projects, encodeCwd(cwd), "another-session.jsonl"), 2000);
    assert.equal(claudeTranscriptPath(cwd, SESSION, projects), moved);
  });

  it("prefers the copy written last when two folders hold the session", () => {
    const { projects, cwd, started } = setup();
    const moved = join(projects, `${encodeCwd(cwd)}-2d-perf`, `${SESSION}.jsonl`);
    write(started, 1000);
    write(moved, 2000);
    assert.equal(claudeTranscriptPath(cwd, SESSION, projects), moved);
  });
});
