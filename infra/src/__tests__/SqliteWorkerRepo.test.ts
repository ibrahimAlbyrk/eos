import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SqliteWorkerRepo } from "../persistence/SqliteWorkerRepo.ts";
import { runMigrations } from "../persistence/MigrationRunner.ts";
import type { InsertWorkerInput } from "../../../core/src/ports/WorkerRepo.ts";

const noopLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => noopLog };

function input(id: string, parentId: string | null, startedAt: number): InsertWorkerInput {
  return {
    id, prompt: "p", cwd: "/tmp", worktreeFrom: null, branch: null, name: null,
    pid: null, port: 7400, startedAt, parentId, model: "opus", effort: null,
    isOrchestrator: false, backendKind: "claude-cli", backendProfile: null,
    agentRole: null, withGateway: true, worktreeDir: null, workspaceOwnerId: null,
    workspaceReady: true,
  };
}

let repo: SqliteWorkerRepo;

beforeEach(() => {
  const db = new DatabaseSync(":memory:");
  runMigrations(db, noopLog as never);
  repo = new SqliteWorkerRepo(db);
});

describe("SqliteWorkerRepo listByParent", () => {
  it("returns only the given parent's children, newest first", () => {
    repo.insert(input("w-a", "orch-1", 100));
    repo.insert(input("w-b", "orch-1", 200));
    repo.insert(input("w-c", "orch-2", 300));
    repo.insert(input("w-d", null, 400));
    assert.deepEqual(repo.listByParent("orch-1").map((w) => w.id), ["w-b", "w-a"]);
    assert.deepEqual(repo.listByParent("orch-2").map((w) => w.id), ["w-c"]);
    assert.deepEqual(repo.listByParent("orch-none").map((w) => w.id), []);
    assert.equal(repo.listAll().length, 4);
  });
});

describe("SqliteWorkerRepo addUsage last_context_tokens", () => {
  it("stamps the turn's full context footprint, overwriting (not accumulating)", () => {
    repo.insert(input("w-u", null, 100));
    repo.addUsage("w-u", { in: 1, out: 50, cacheRead: 133997, cacheCreate: 0, cacheCreate1h: 154, costUsd: 0.01 });
    assert.equal(repo.findById("w-u")?.last_context_tokens, 134152);
    // Cache-cold turn (model switch): whole context lands in cacheCreate1h.
    repo.addUsage("w-u", { in: 10, out: 389, cacheRead: 0, cacheCreate: 0, cacheCreate1h: 126299, costUsd: 0.25 });
    assert.equal(repo.findById("w-u")?.last_context_tokens, 126309);
    assert.equal(repo.findById("w-u")?.tokens_in, 11);
  });
});

describe("SqliteWorkerRepo workspace_ready", () => {
  it("persists 0 for a not-ready insert and flips via setWorkspaceReady", () => {
    repo.insert({ ...input("w-wt", null, 100), worktreeFrom: "/repo", branch: "eos-x", worktreeDir: "/repo/.eos/worktrees/eos-x", workspaceReady: false });
    assert.equal(repo.findById("w-wt")?.workspace_ready, 0);
    repo.setWorkspaceReady("w-wt");
    assert.equal(repo.findById("w-wt")?.workspace_ready, 1);
  });

  it("persists 1 for a ready insert (plain cwd / attach)", () => {
    repo.insert(input("w-cwd", null, 100));
    assert.equal(repo.findById("w-cwd")?.workspace_ready, 1);
  });
});
