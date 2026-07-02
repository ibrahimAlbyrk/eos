import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setWorkerModel, type SetWorkerModelDeps } from "../use-cases/SetWorkerModel.ts";
import type { WorkerRow } from "../../../contracts/src/worker.ts";
import type { AgentBackend, AgentSession } from "../ports/AgentBackend.ts";

interface AppendedEvent { type: string; payload: Record<string, unknown> }

function buildDeps(opts: {
  processModel?: "in-process" | "out-of-process";
  alive?: boolean;
  runtimeModelSwitch?: boolean;
  setModelResult?: { ok: boolean; reason?: string };
  row?: Partial<WorkerRow>;
  models?: { kind: string; models?: readonly string[] };
} = {}): {
  deps: SetWorkerModelDeps;
  events: AppendedEvent[];
  updated: Array<{ model: string; effort: string | null }>;
  switched: Array<{ model: string; effort?: string | null }>;
  handles: Array<{ kind: string }>;
} {
  const events: AppendedEvent[] = [];
  const updated: Array<{ model: string; effort: string | null }> = [];
  const switched: Array<{ model: string; effort?: string | null }> = [];
  const handles: Array<{ kind: string }> = [];
  const row = { id: "w1", port: 7501, pid: 42, ...opts.row } as unknown as WorkerRow;

  const session = {
    capabilities: { runtimeModelSwitch: opts.runtimeModelSwitch ?? true },
    isAlive: () => opts.alive ?? true,
    setModel: async (model: string, effort?: string | null) => {
      switched.push({ model, effort });
      return opts.setModelResult ?? { ok: true };
    },
  } as unknown as AgentSession;

  const backend = {
    kind: "fake",
    descriptor: { processModel: opts.processModel ?? "out-of-process", label: "Fake", models: opts.models },
    attach: (_id: string, handle: { kind: string }) => { handles.push(handle); return session; },
  } as unknown as AgentBackend;

  const deps = {
    workers: {
      findById: () => row,
      updateModel: (_id: string, model: string, effort: string | null) => { updated.push({ model, effort }); },
    },
    events: { append: (_id: string, _ts: number, type: string, payload: Record<string, unknown>) => { events.push({ type, payload }); return events.length; } },
    bus: { publish: () => {} },
    clock: { now: () => 1 },
    backend,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as SetWorkerModelDeps;

  return { deps, events, updated, switched, handles };
}

describe("setWorkerModel — backend-port runtime apply", () => {
  it("persists, then applies live via the session when runtimeModelSwitch is true", async () => {
    const { deps, updated, switched, events } = buildDeps({ runtimeModelSwitch: true });
    const out = await setWorkerModel(deps, { workerId: "w1", model: "opus", effort: "high" });
    assert.deepEqual(updated, [{ model: "opus", effort: "high" }]);
    assert.deepEqual(switched, [{ model: "opus", effort: "high" }]);
    assert.equal(out.runtimeApplied, true);
    const ev = events.find((e) => e.type === "lifecycle");
    assert.equal(ev?.payload.kind, "model_set");
    assert.equal(ev?.payload.runtimeApplied, true);
  });

  it("persists but does NOT apply live when the backend lacks runtimeModelSwitch", async () => {
    const { deps, updated, switched } = buildDeps({ runtimeModelSwitch: false });
    const out = await setWorkerModel(deps, { workerId: "w1", model: "opus" });
    assert.deepEqual(updated, [{ model: "opus", effort: null }]);
    assert.deepEqual(switched, []);
    assert.equal(out.runtimeApplied, false);
  });

  it("persists but does NOT apply when the session is dead", async () => {
    const { deps, switched } = buildDeps({ alive: false });
    const out = await setWorkerModel(deps, { workerId: "w1", model: "opus" });
    assert.deepEqual(switched, []);
    assert.equal(out.runtimeApplied, false);
  });

  it("builds an inproc handle for in-process backends (no port dependency)", async () => {
    const { deps, switched, handles } = buildDeps({ processModel: "in-process", row: { port: null, pid: null } });
    const out = await setWorkerModel(deps, { workerId: "w1", model: "sonnet" });
    assert.deepEqual(handles, [{ kind: "inproc", ref: "w1" }]);
    assert.deepEqual(switched, [{ model: "sonnet", effort: null }]);
    assert.equal(out.runtimeApplied, true);
  });

  it("builds an http handle (port/pid) for out-of-process backends", async () => {
    const { deps, handles } = buildDeps({ processModel: "out-of-process" });
    await setWorkerModel(deps, { workerId: "w1", model: "opus" });
    assert.deepEqual(handles, [{ kind: "http", port: 7501, pid: 42 }]);
  });
});

describe("setWorkerModel — model↔provider guard", () => {
  it("rejects a model that doesn't belong to the provider, persisting nothing", async () => {
    const { deps, updated, switched } = buildDeps({ models: { kind: "claude" } });
    await assert.rejects(
      () => setWorkerModel(deps, { workerId: "w1", model: "deepseek-chat" }),
      /deepseek-chat/,
    );
    assert.deepEqual(updated, []);
    assert.deepEqual(switched, []);
  });

  it("persists a model that matches the provider's catalog", async () => {
    const { deps, updated } = buildDeps({ models: { kind: "claude" } });
    const out = await setWorkerModel(deps, { workerId: "w1", model: "opus" });
    assert.deepEqual(updated, [{ model: "opus", effort: null }]);
    assert.equal(out.model, "opus");
  });
});
