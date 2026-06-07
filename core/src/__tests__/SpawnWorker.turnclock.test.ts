import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnWorker, type SpawnWorkerDeps } from "../use-cases/SpawnWorker.ts";

const TS = 123456789;

function buildDeps(): { deps: SpawnWorkerDeps; stamps: { id: string; ts: number }[] } {
  const stamps: { id: string; ts: number }[] = [];
  const deps = {
    workers: {
      insert: () => {},
      updatePermissionMode: () => {},
      setTurnStartedAt: (id: string, ts: number) => { stamps.push({ id, ts }); },
    },
    events: { append: () => 1 },
    bus: { publish: () => {} },
    supervisor: { spawn: () => ({ pid: 111 }) },
    ports: { allocate: async () => 7421, release: () => {} },
    clock: { now: () => TS },
    ids: { newWorkerId: () => "w-fixed" },
    log: { info: () => {}, warn: () => {}, error: () => {}, child: () => deps.log },
    buildArgs: () => [],
    buildEnv: () => ({}),
    logFileFor: () => "/tmp/log",
    recents: { push: () => {} },
  } as unknown as SpawnWorkerDeps;
  return { deps, stamps };
}

describe("spawnWorker — boot-turn clock", () => {
  it("stamps turn_started_at when spawned with a prompt", async () => {
    const { deps, stamps } = buildDeps();
    await spawnWorker(deps, { prompt: "do the thing", cwd: "/some/dir" });
    assert.deepEqual(stamps, [{ id: "w-fixed", ts: TS }]);
  });

  it("does not stamp on a promptless spawn", async () => {
    const { deps, stamps } = buildDeps();
    await spawnWorker(deps, { prompt: "", cwd: "/some/dir" });
    assert.equal(stamps.length, 0);
  });

  it("does not stamp on a whitespace-only prompt", async () => {
    const { deps, stamps } = buildDeps();
    await spawnWorker(deps, { prompt: "   ", cwd: "/some/dir" });
    assert.equal(stamps.length, 0);
  });
});
