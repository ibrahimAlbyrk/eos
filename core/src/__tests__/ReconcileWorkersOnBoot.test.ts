import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reconcileWorkersOnBoot, type ReconcileWorkersOnBootDeps } from "../use-cases/ReconcileWorkersOnBoot.ts";
import type { WorkerRow } from "../../../contracts/src/worker.ts";
import type { WorkerState } from "../../../contracts/src/events.ts";

const NOW = 1_000_000;

interface RowSeed {
  id: string;
  state: WorkerState;
  session_id?: string | null;
  cwd?: string | null;
  worktree_dir?: string | null;
}

function buildDeps(seeds: RowSeed[], existingPaths: string[] = []): {
  deps: ReconcileWorkersOnBootDeps;
  rows: Map<string, RowSeed & { ended_at?: number; exit_code?: number | null }>;
  cleared: string[];
  appended: Array<{ id: string; type: string }>;
} {
  const rows = new Map(seeds.map((s) => [s.id, { session_id: null, cwd: null, worktree_dir: null, ...s }]));
  const cleared: string[] = [];
  const appended: Array<{ id: string; type: string }> = [];
  const exists = new Set(existingPaths);

  const workers = {
    listAll: () => [...rows.values()] as unknown as WorkerRow[],
    findById: (id: string) => (rows.get(id) ?? null) as unknown as WorkerRow,
    updateState: (id: string, state: WorkerState) => { rows.get(id)!.state = state; },
    setTurnStartedAt: () => {},
    markDone: (id: string, endedAt: number, exitCode: number | null) => {
      const r = rows.get(id)!;
      r.state = "DONE"; r.ended_at = endedAt; r.exit_code = exitCode;
    },
    clearRuntime: (id: string) => { cleared.push(id); },
  } as unknown as ReconcileWorkersOnBootDeps["workers"];

  const deps = {
    workers,
    events: { append: (id: string, _ts: number, type: string) => { appended.push({ id, type }); return appended.length; } },
    bus: { publish: () => {} },
    clock: { now: () => NOW },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    pathExists: (p: string) => exists.has(p),
  } as unknown as ReconcileWorkersOnBootDeps;

  return { deps, rows, cleared, appended };
}

describe("reconcileWorkersOnBoot", () => {
  it("suspends a live row with session_id + existing cwd, nulling pid/port", () => {
    const { deps, rows, cleared } = buildDeps(
      [{ id: "w1", state: "WORKING", session_id: "s-1", cwd: "/proj" }],
      ["/proj"],
    );
    const res = reconcileWorkersOnBoot(deps);
    assert.equal(rows.get("w1")!.state, "SUSPENDED");
    assert.deepEqual(cleared, ["w1"]);
    assert.deepEqual(res, { suspended: 1, closed: 0 });
  });

  it("prefers worktree_dir over cwd for the existence probe", () => {
    const { deps, rows } = buildDeps(
      [{ id: "w1", state: "IDLE", session_id: "s-1", cwd: "/gone", worktree_dir: "/wt" }],
      ["/wt"],
    );
    reconcileWorkersOnBoot(deps);
    assert.equal(rows.get("w1")!.state, "SUSPENDED");
  });

  it("closes a row whose cwd no longer exists", () => {
    const { deps, rows, appended } = buildDeps(
      [{ id: "w1", state: "IDLE", session_id: "s-1", cwd: "/gone" }],
    );
    const res = reconcileWorkersOnBoot(deps);
    assert.equal(rows.get("w1")!.state, "DONE");
    assert.equal(rows.get("w1")!.ended_at, NOW);
    assert.deepEqual(appended, [{ id: "w1", type: "exit" }]);
    assert.deepEqual(res, { suspended: 0, closed: 1 });
  });

  it("closes a row with no session_id", () => {
    const { deps, rows } = buildDeps(
      [{ id: "w1", state: "WORKING", cwd: "/proj" }],
      ["/proj"],
    );
    reconcileWorkersOnBoot(deps);
    assert.equal(rows.get("w1")!.state, "DONE");
  });

  it("closes ENDING/KILLING rows even when resumable", () => {
    const { deps, rows } = buildDeps(
      [
        { id: "w1", state: "ENDING", session_id: "s-1", cwd: "/proj" },
        { id: "w2", state: "KILLING", session_id: "s-2", cwd: "/proj" },
      ],
      ["/proj"],
    );
    const res = reconcileWorkersOnBoot(deps);
    assert.equal(rows.get("w1")!.state, "DONE");
    assert.equal(rows.get("w2")!.state, "DONE");
    assert.deepEqual(res, { suspended: 0, closed: 2 });
  });

  it("leaves DONE and SUSPENDED rows untouched", () => {
    const { deps, rows, appended } = buildDeps([
      { id: "w1", state: "DONE", session_id: "s-1", cwd: "/proj" },
      { id: "w2", state: "SUSPENDED", session_id: "s-2", cwd: "/proj" },
    ]);
    const res = reconcileWorkersOnBoot(deps);
    assert.equal(rows.get("w1")!.state, "DONE");
    assert.equal(rows.get("w2")!.state, "SUSPENDED");
    assert.deepEqual(appended, []);
    assert.deepEqual(res, { suspended: 0, closed: 0 });
  });
});
