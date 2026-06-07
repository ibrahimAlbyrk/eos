import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resumeWorker, type ResumeWorkerDeps } from "../use-cases/ResumeWorker.ts";
import { ConflictError, NotFoundError } from "../errors/index.ts";
import type { WorkerRow } from "../../../contracts/src/worker.ts";
import type { WorkerState } from "../../../contracts/src/events.ts";
import type { SpawnWorkerSpec } from "../use-cases/SpawnWorker.ts";
import type { AgentLaunchSpec } from "../ports/AgentBackend.ts";

const NOW = 5_000;

interface RowSeed {
  id: string;
  state: WorkerState;
  session_id?: string | null;
  backend_kind?: string | null;
}

function buildDeps(seed: RowSeed, opts: { live?: boolean; paths?: string[]; startFails?: boolean } = {}): {
  deps: ResumeWorkerDeps;
  row: RowSeed & { ended_at?: number };
  launches: AgentLaunchSpec[];
  reactivations: Array<{ id: string; pid: number | null; port: number }>;
  appended: Array<{ type: string; payload: unknown }>;
} {
  const row = { session_id: "s-1", backend_kind: "claude-cli", ...seed };
  const launches: AgentLaunchSpec[] = [];
  const reactivations: Array<{ id: string; pid: number | null; port: number }> = [];
  const appended: Array<{ type: string; payload: unknown }> = [];
  const exists = new Set(opts.paths ?? ["/proj"]);

  const deps = {
    workers: {
      findById: () => row as unknown as WorkerRow,
      updateState: (_id: string, next: WorkerState) => { row.state = next; },
      setTurnStartedAt: () => {},
      markDone: () => {},
      reactivate: (id: string, rt: { pid: number | null; port: number }) => {
        reactivations.push({ id, ...rt });
      },
    },
    events: { append: (_id: string, _ts: number, type: string, payload: unknown) => { appended.push({ type, payload }); return appended.length; } },
    bus: { publish: () => {} },
    clock: { now: () => NOW },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    backend: {
      kind: "claude-cli",
      start: async (spec: AgentLaunchSpec) => {
        if (opts.startFails) throw new Error("spawn blew up");
        launches.push(spec);
        return { handle: { kind: "http", port: 7600, pid: 4242 } };
      },
      attach: () => { throw new Error("unused"); },
    },
    isLive: () => !!opts.live,
    pathExists: (p: string) => exists.has(p),
  } as unknown as ResumeWorkerDeps;

  return { deps, row, launches, reactivations, appended };
}

const SPEC: SpawnWorkerSpec = { prompt: "", cwd: "/proj", model: "haiku", effort: "low" };

describe("resumeWorker — guards", () => {
  it("404s on unknown worker", async () => {
    const { deps } = buildDeps({ id: "w1", state: "SUSPENDED" });
    (deps.workers as { findById(id: string): WorkerRow | null }).findById = () => null;
    await assert.rejects(resumeWorker(deps, { workerId: "w1", spec: SPEC }), NotFoundError);
  });

  it("rejects non-claude-cli backends", async () => {
    const { deps } = buildDeps({ id: "w1", state: "SUSPENDED", backend_kind: "anthropic-api" });
    await assert.rejects(resumeWorker(deps, { workerId: "w1", spec: SPEC }), ConflictError);
  });

  it("rejects non-resumable states", async () => {
    for (const state of ["SPAWNING", "WORKING", "IDLE", "ENDING", "KILLING"] as WorkerState[]) {
      const { deps } = buildDeps({ id: "w1", state });
      await assert.rejects(resumeWorker(deps, { workerId: "w1", spec: SPEC }), ConflictError, state);
    }
  });

  it("rejects a row with no recorded session", async () => {
    const { deps } = buildDeps({ id: "w1", state: "SUSPENDED", session_id: null });
    await assert.rejects(resumeWorker(deps, { workerId: "w1", spec: SPEC }), ConflictError);
  });

  it("rejects when the process is still alive", async () => {
    const { deps } = buildDeps({ id: "w1", state: "SUSPENDED" }, { live: true });
    await assert.rejects(resumeWorker(deps, { workerId: "w1", spec: SPEC }), ConflictError);
  });

  it("rejects when the workspace dir is gone", async () => {
    const { deps } = buildDeps({ id: "w1", state: "SUSPENDED" }, { paths: [] });
    await assert.rejects(resumeWorker(deps, { workerId: "w1", spec: SPEC }), ConflictError);
  });
});

describe("resumeWorker — happy path", () => {
  it("relaunches with --resume spec, reactivates the row, appends spawn{resumed}", async () => {
    const { deps, row, launches, reactivations, appended } = buildDeps({ id: "w1", state: "SUSPENDED" });
    const result = await resumeWorker(deps, { workerId: "w1", spec: SPEC });

    assert.deepEqual(result, { id: "w1", port: 7600 });
    assert.equal(row.state, "SPAWNING");
    assert.equal(launches.length, 1);
    assert.equal(launches[0].prompt, "");
    const launched = (launches[0].backendOptions?.spec ?? {}) as SpawnWorkerSpec;
    assert.equal(launched.resumeSessionId, "s-1");
    assert.equal(launched.prompt, "");
    assert.deepEqual(reactivations, [{ id: "w1", pid: 4242, port: 7600 }]);
    const spawn = appended.find((e) => e.type === "spawn");
    assert.deepEqual(spawn?.payload, { resumed: true, sessionId: "s-1", pid: 4242 });
  });

  it("resumes a DONE worker too", async () => {
    const { deps, row } = buildDeps({ id: "w1", state: "DONE" });
    await resumeWorker(deps, { workerId: "w1", spec: SPEC });
    assert.equal(row.state, "SPAWNING");
  });

  it("reverts to SUSPENDED when the launch throws", async () => {
    const { deps, row, reactivations } = buildDeps({ id: "w1", state: "SUSPENDED" }, { startFails: true });
    await assert.rejects(resumeWorker(deps, { workerId: "w1", spec: SPEC }), /spawn blew up/);
    assert.equal(row.state, "SUSPENDED");
    assert.deepEqual(reactivations, []);
  });
});
