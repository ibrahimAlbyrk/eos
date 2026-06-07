import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnWorker, type SpawnWorkerDeps } from "../use-cases/SpawnWorker.ts";
import { createFakeAgentBackend } from "../../../infra/src/backends/FakeAgentBackend.ts";

// Phase 1: when an AgentBackend is injected, spawn goes through it and the legacy
// supervisor/port path is bypassed entirely (the kill switch is "no backend").

function buildDeps(backend: ReturnType<typeof createFakeAgentBackend>) {
  const inserted: Array<Record<string, unknown>> = [];
  const log = { info() {}, warn() {}, error() {}, child() { return log; } };
  const deps = {
    workers: { insert: (r: Record<string, unknown>) => { inserted.push(r); }, updatePermissionMode: () => {}, setTurnStartedAt: () => {} },
    events: { append: () => 1 },
    bus: { publish: () => {} },
    clock: { now: () => 1000 },
    ids: { newWorkerId: () => "w-fake" },
    log,
    backend,
    // Legacy deps — must NOT be touched on the backend path; tripwires below.
    ports: { allocate: async () => { throw new Error("legacy ports.allocate called"); }, release: () => { throw new Error("legacy ports.release called"); } },
    supervisor: { spawn: () => { throw new Error("legacy supervisor.spawn called"); } },
    buildArgs: () => { throw new Error("legacy buildArgs called"); },
    buildEnv: () => { throw new Error("legacy buildEnv called"); },
    logFileFor: () => { throw new Error("legacy logFileFor called"); },
  } as unknown as SpawnWorkerDeps;
  return { deps, inserted };
}

describe("spawnWorker — backend path", () => {
  it("spawns via the injected AgentBackend and persists the result", async () => {
    const backend = createFakeAgentBackend();
    const { deps, inserted } = buildDeps(backend);
    const res = await spawnWorker(deps, { prompt: "hi", cwd: "/tmp", model: "sonnet" });
    assert.equal(res.id, "w-fake");
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].model, "sonnet");
    assert.equal(inserted[0].pid, null); // fake → inproc handle
    assert.deepEqual(backend.sessions.get("w-fake")?.messages, ["hi"]);
  });

  it("never touches the legacy supervisor/ports when a backend is injected", async () => {
    const backend = createFakeAgentBackend();
    const { deps } = buildDeps(backend);
    // The legacy stubs throw if called — this resolves only if they were not.
    await assert.doesNotReject(spawnWorker(deps, { prompt: "x", cwd: "/tmp" }));
  });
});
