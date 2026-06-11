import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnWorker, type SpawnWorkerDeps, type SpawnWorkerSpec } from "../use-cases/SpawnWorker.ts";
import { ConflictError, NotFoundError, PermissionDeniedError } from "../errors/index.ts";

const TS = 123456789;

interface InsertedRow {
  branch: string | null;
  worktreeFrom: string | null;
  worktreeDir: string | null;
  workspaceOwnerId: string | null;
}

function buildDeps(target?: Record<string, unknown>): {
  deps: SpawnWorkerDeps;
  inserted: InsertedRow[];
  argSpecs: SpawnWorkerSpec[];
} {
  const inserted: InsertedRow[] = [];
  const argSpecs: SpawnWorkerSpec[] = [];
  const deps = {
    workers: {
      insert: (input: InsertedRow) => { inserted.push(input); },
      findById: () => target ?? null,
      updatePermissionMode: () => {},
      setTurnStartedAt: () => {},
    },
    events: { append: () => 1 },
    bus: { publish: () => {} },
    supervisor: { spawn: () => ({ pid: 111 }) },
    ports: { allocate: async () => 7421, release: () => {} },
    clock: { now: () => TS },
    ids: { newWorkerId: () => "w-new" },
    log: { info: () => {}, warn: () => {}, error: () => {}, child: () => deps.log },
    buildArgs: ({ spec }: { spec: SpawnWorkerSpec }) => { argSpecs.push(spec); return []; },
    buildEnv: () => ({}),
    resolveWorktreeDir: (repoRoot: string, branch: string) => `${repoRoot}/.eos/worktrees/${branch}`,
    logFileFor: () => "/tmp/log",
    recents: { push: () => {} },
  } as unknown as SpawnWorkerDeps;
  return { deps, inserted, argSpecs };
}

const TARGET = {
  id: "w-owner",
  state: "IDLE",
  worktree_from: "/repo",
  branch: "eos-owner-x",
  worktree_dir: "/repo/.eos/worktrees/eos-owner-x",
};

describe("spawnWorker — workspaceOf attach + worktree_dir precompute", () => {
  it("copies the target's worktree facts and records the owner", async () => {
    const { deps, inserted, argSpecs } = buildDeps(TARGET);
    await spawnWorker(deps, { prompt: "p", workspaceOf: "w-owner" });
    assert.equal(inserted[0].worktreeFrom, "/repo");
    assert.equal(inserted[0].branch, "eos-owner-x");
    assert.equal(inserted[0].worktreeDir, TARGET.worktree_dir);
    assert.equal(inserted[0].workspaceOwnerId, "w-owner");
    assert.equal(argSpecs[0].worktreeDir, TARGET.worktree_dir);
    assert.equal(argSpecs[0].workspaceOf, "w-owner");
  });

  it("refuses to attach while the target is busy", async () => {
    const { deps } = buildDeps({ ...TARGET, state: "WORKING" });
    await assert.rejects(spawnWorker(deps, { prompt: "p", workspaceOf: "w-owner" }), ConflictError);
  });

  it("refuses to attach to a worker without a worktree", async () => {
    const { deps } = buildDeps({ id: "w-plain", state: "IDLE", cwd: "/dir", worktree_from: null, branch: null, worktree_dir: null });
    await assert.rejects(spawnWorker(deps, { prompt: "p", workspaceOf: "w-plain" }), ConflictError);
  });

  it("rejects a missing target with NotFound", async () => {
    const { deps } = buildDeps(undefined);
    await assert.rejects(spawnWorker(deps, { prompt: "p", workspaceOf: "w-gone" }), NotFoundError);
  });

  it("denies an orchestrator attaching to another orchestrator's worker", async () => {
    const { deps } = buildDeps({ ...TARGET, parent_id: "orch-other" });
    await assert.rejects(
      spawnWorker(deps, { prompt: "p", workspaceOf: "w-owner", parentId: "orch-1" }),
      PermissionDeniedError,
    );
  });

  it("allows an orchestrator attaching to its own worker", async () => {
    const { deps, inserted } = buildDeps({ ...TARGET, parent_id: "orch-1" });
    await spawnWorker(deps, { prompt: "p", workspaceOf: "w-owner", parentId: "orch-1" });
    assert.equal(inserted[0].workspaceOwnerId, "w-owner");
  });

  it("precomputes worktree_dir for a fresh worktree spawn", async () => {
    const { deps, inserted, argSpecs } = buildDeps();
    await spawnWorker(deps, { prompt: "p", name: "test", worktreeFrom: "/repo" });
    const branch = `eos-test-w-new-${TS.toString(36)}`;
    assert.equal(inserted[0].worktreeDir, `/repo/.eos/worktrees/${branch}`);
    assert.equal(inserted[0].workspaceOwnerId, null);
    assert.equal(argSpecs[0].worktreeDir, `/repo/.eos/worktrees/${branch}`);
    assert.equal(argSpecs[0].workspaceOf, undefined);
  });

  it("leaves worktree_dir null for a plain-cwd worker", async () => {
    const { deps, inserted } = buildDeps();
    await spawnWorker(deps, { prompt: "p", cwd: "/some/dir" });
    assert.equal(inserted[0].worktreeDir, null);
    assert.equal(inserted[0].workspaceOwnerId, null);
  });
});
