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

  it("defaults effort to xhigh and persists it", async () => {
    const { deps, inserted } = buildDeps(createFakeAgentBackend());
    await spawnWorker(deps, { prompt: "x", cwd: "/tmp" });
    assert.equal(inserted[0].effort, "xhigh");
  });

  it("drops effort when caps say the model has none", async () => {
    const { deps, inserted } = buildDeps(createFakeAgentBackend());
    deps.caps = { effortLevelsFor: async () => [] };
    await spawnWorker(deps, { prompt: "x", cwd: "/tmp", model: "haiku" });
    assert.equal(inserted[0].effort, null);
  });

  it("clamps a requested effort down to the model's capability", async () => {
    const { deps, inserted } = buildDeps(createFakeAgentBackend());
    deps.caps = { effortLevelsFor: async () => ["low", "medium", "high", "max"] };
    await spawnWorker(deps, { prompt: "x", cwd: "/tmp", model: "claude-opus-4-6" });
    assert.equal(inserted[0].effort, "high"); // default xhigh → clamped
  });
});

// In-process backends (claude-sdk) have no boot child to create the worktree, so
// the daemon materializes it in SpawnWorker before launch. Out-of-process
// (claude-cli) creates its own in worker.ts, so SpawnWorker must NOT create here.
describe("spawnWorker — in-process worktree bootstrap", () => {
  function harness(processModel: "in-process" | "out-of-process") {
    const inserted: Array<Record<string, unknown>> = [];
    const createCalls: Array<Record<string, unknown>> = [];
    let launchCwd: string | undefined;
    let forkBase: string | undefined;
    const log = { info() {}, warn() {}, error() {}, child() { return log; } };
    const backend = {
      kind: "fake",
      descriptor: { kind: "fake", label: "F", processModel, billing: "subscription", modelSource: "request", capabilities: {}, models: { kind: "claude" }, auth: "subscription", enabled: true },
      async start(spec: { cwd: string; workerId: string }, cb?: { onSpawn?: (h: unknown) => void }) {
        launchCwd = spec.cwd;
        const handle = processModel === "in-process" ? { kind: "inproc", ref: spec.workerId } : { kind: "http", port: 1, pid: 2 };
        cb?.onSpawn?.(handle);
        return { handle };
      },
      attach() { return {}; },
    };
    const deps = {
      workers: { insert: (r: Record<string, unknown>) => inserted.push(r), updatePermissionMode: () => {}, setTurnStartedAt: () => {}, setForkBaseSha: (_id: string, sha: string) => { forkBase = sha; } },
      events: { append: () => 1 },
      bus: { publish: () => {} },
      clock: { now: () => 1000 },
      ids: { newWorkerId: () => "w1" },
      log,
      backend,
      worktrees: { create: async (i: Record<string, unknown>) => { createCalls.push(i); return { created: true, worktreeDir: "/repo/.eos/worktrees/br", forkBaseSha: "abc123" }; } },
      resolveWorktreeDir: (root: string, branch: string) => `${root}/.eos/worktrees/${branch}`,
    } as unknown as SpawnWorkerDeps;
    return { deps, inserted, createCalls, get launchCwd() { return launchCwd; }, get forkBase() { return forkBase; } };
  }

  it("materializes the worktree, launches IN it, flips workspace_ready, persists the fork base", async () => {
    const h = harness("in-process");
    await spawnWorker(h.deps, { prompt: "go", worktreeFrom: "/repo", hydrateEnv: true });
    assert.equal(h.createCalls.length, 1);
    assert.equal(h.createCalls[0].repoRoot, "/repo");
    assert.equal(h.createCalls[0].hydrateEnv, true); // hydrate intent threaded to the port
    // Launched in the created worktree — NOT the source repo (the bug).
    assert.equal(h.launchCwd, "/repo/.eos/worktrees/br");
    assert.equal(h.inserted[0].workspaceReady, true);
    assert.equal(h.forkBase, "abc123");
  });

  it("does NOT create a worktree for an out-of-process backend (worker.ts owns that)", async () => {
    const h = harness("out-of-process");
    await spawnWorker(h.deps, { prompt: "go", worktreeFrom: "/repo" });
    assert.equal(h.createCalls.length, 0);
    assert.equal(h.inserted[0].workspaceReady, false); // born not-ready; the boot event flips it
  });

  it("does NOT create a worktree for a plain-cwd in-process spawn", async () => {
    const h = harness("in-process");
    await spawnWorker(h.deps, { prompt: "go", cwd: "/plain" });
    assert.equal(h.createCalls.length, 0);
    assert.equal(h.launchCwd, "/plain");
    assert.equal(h.inserted[0].workspaceReady, true); // no worktreeFrom → ready
  });
});
