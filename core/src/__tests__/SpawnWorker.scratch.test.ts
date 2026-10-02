import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnWorker, type SpawnWorkerDeps } from "../use-cases/SpawnWorker.ts";
import type { InsertWorkerInput } from "../ports/WorkerRepo.ts";

function buildDeps(): { deps: SpawnWorkerDeps; inserted: InsertWorkerInput[]; recents: string[] } {
  const inserted: InsertWorkerInput[] = [];
  const recents: string[] = [];
  const deps = {
    workers: { insert: (i: InsertWorkerInput) => { inserted.push(i); }, updatePermissionMode: () => {}, setTurnStartedAt: () => {} },
    events: { append: () => 1 },
    bus: { publish: () => {} },
    supervisor: { spawn: () => ({ pid: 111 }) },
    ports: { allocate: async () => 7421, release: () => {} },
    clock: { now: () => 1 },
    ids: { newWorkerId: () => "w-fixed" },
    log: { info: () => {}, warn: () => {}, error: () => {}, child: () => deps.log },
    buildArgs: () => [],
    buildEnv: () => ({}),
    logFileFor: () => "/tmp/log",
    recents: { push: (p: string) => { recents.push(p); } },
  } as unknown as SpawnWorkerDeps;
  return { deps, inserted, recents };
}

describe("spawnWorker — No folder (scratch)", () => {
  it("persists the scratch flag and keeps the folder out of recents", async () => {
    const { deps, inserted, recents } = buildDeps();
    await spawnWorker(deps, { prompt: "", cwd: "/home/.eos/scratch/w-fixed", scratch: true });
    assert.equal(inserted[0].scratch, true);
    assert.deepEqual(recents, []);
  });

  it("a plain folder is not scratch and lands in recents", async () => {
    const { deps, inserted, recents } = buildDeps();
    await spawnWorker(deps, { prompt: "", cwd: "/some/dir" });
    assert.equal(inserted[0].scratch, false);
    assert.deepEqual(recents, ["/some/dir"]);
  });
});
