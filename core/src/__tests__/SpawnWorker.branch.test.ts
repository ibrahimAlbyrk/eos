import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnWorker, type SpawnWorkerDeps, type SpawnWorkerSpec } from "../use-cases/SpawnWorker.ts";

const TS = 123456789;

function buildDeps(): { deps: SpawnWorkerDeps; inserted: { branch: string | null }[]; argSpecs: SpawnWorkerSpec[] } {
  const inserted: { branch: string | null }[] = [];
  const argSpecs: SpawnWorkerSpec[] = [];
  const deps = {
    workers: {
      insert: (input: { branch: string | null }) => { inserted.push(input); },
      updatePermissionMode: () => {},
      setTurnStartedAt: () => {},
    },
    events: { append: () => 1 },
    bus: { publish: () => {} },
    supervisor: { spawn: () => ({ pid: 111 }) },
    ports: { allocate: async () => 7421, release: () => {} },
    clock: { now: () => TS },
    ids: { newWorkerId: () => "w-fixed" },
    log: { info: () => {}, warn: () => {}, error: () => {}, child: () => deps.log },
    buildArgs: ({ spec }: { spec: SpawnWorkerSpec }) => { argSpecs.push(spec); return []; },
    buildEnv: () => ({}),
    logFileFor: () => "/tmp/log",
    recents: { push: () => {} },
  } as unknown as SpawnWorkerDeps;
  return { deps, inserted, argSpecs };
}

describe("spawnWorker — daemon-side branch generation", () => {
  it("generates cm-<name>-<id>-<clock36> when worktreeFrom is set and no branch given", async () => {
    const { deps, inserted, argSpecs } = buildDeps();
    await spawnWorker(deps, { prompt: "p", name: "test", worktreeFrom: "/repo" });
    const expected = `cm-test-w-fixed-${TS.toString(36)}`;
    assert.equal(inserted[0].branch, expected);
    assert.equal(argSpecs[0].branch, expected);
  });

  it("omits the label but keeps the unique id when no name is provided", async () => {
    const { deps, inserted } = buildDeps();
    await spawnWorker(deps, { prompt: "p", worktreeFrom: "/repo" });
    assert.equal(inserted[0].branch, `cm-w-fixed-${TS.toString(36)}`);
  });

  it("passes an explicit branch through unchanged", async () => {
    const { deps, inserted, argSpecs } = buildDeps();
    await spawnWorker(deps, { prompt: "p", name: "test", worktreeFrom: "/repo", branch: "feature/x" });
    assert.equal(inserted[0].branch, "feature/x");
    assert.equal(argSpecs[0].branch, "feature/x");
  });

  it("leaves branch null for a plain-cwd worker (no worktreeFrom)", async () => {
    const { deps, inserted, argSpecs } = buildDeps();
    await spawnWorker(deps, { prompt: "p", name: "test", cwd: "/some/dir" });
    assert.equal(inserted[0].branch, null);
    assert.equal(argSpecs[0].branch, undefined);
  });
});
