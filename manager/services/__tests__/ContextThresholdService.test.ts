import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ContextThresholdService, type ContextThresholdDeps } from "../ContextThresholdService.ts";

const noopLog = { debug() {}, info() {}, warn() {}, error() {}, child() { return noopLog; } };
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

// A tiny in-memory latch mirroring ContextMarkRepo's exactly-once + reset semantics.
function fakeMarks() {
  const state = new Map<string, Set<string>>();
  return {
    mark(id: string, stage: string): boolean {
      const s = state.get(id) ?? new Set<string>();
      if (s.has(stage)) return false;
      s.add(stage); state.set(id, s); return true;
    },
    clear(id: string): void { state.delete(id); },
    has(id: string, stage: string): boolean { return state.get(id)?.has(stage) ?? false; },
  };
}

// The window is 100k tokens: used=90k → pct 90, used=95k → pct 95, used=50k → 50.
function makeSvc(opts: { parentId?: string | null; limit?: number | null; name?: string | null } = {}) {
  const dispatched: Array<{ workerId: string; text: string; envelope: any; queueWhenBusy: boolean; origin: string }> = [];
  const suspended: Array<{ id: string; reason: string }> = [];
  const worker = {
    id: "w-1",
    name: opts.name === undefined ? "alice" : opts.name,
    parent_id: opts.parentId === undefined ? "p-1" : opts.parentId,
    model: "opus",
    last_context_tokens: 0 as number,
  };
  const marks = fakeMarks();
  const deps = {
    workers: { findById: (id: string) => (id === "w-1" ? worker : null) },
    marks,
    contextWindowFor: () => (opts.limit === undefined ? 100_000 : opts.limit),
    dispatch: async (input: typeof dispatched[number]) => { dispatched.push(input); return {}; },
    suspend: (id: string, reason: string) => { suspended.push({ id, reason }); },
    warnRatio: 0.9,
    fullRatio: 0.95,
    log: noopLog,
  } as unknown as ContextThresholdDeps;
  const svc = new ContextThresholdService(deps);
  const setUsed = (n: number) => { worker.last_context_tokens = n; };
  return { svc, dispatched, suspended, marks, setUsed };
}

describe("ContextThresholdService.checkOnIdle", () => {
  it("below the warn threshold: silent", async () => {
    const { svc, dispatched, suspended, setUsed } = makeSvc();
    setUsed(50_000); // pct 50
    svc.checkOnIdle("w-1");
    await flush();
    assert.equal(dispatched.length, 0);
    assert.equal(suspended.length, 0);
  });

  it("fires the warn heads-up exactly once at the 90% crossing", async () => {
    const { svc, dispatched, suspended, setUsed } = makeSvc();
    setUsed(90_000); // pct 90
    svc.checkOnIdle("w-1");
    await flush();
    assert.equal(dispatched.length, 1);
    assert.equal(suspended.length, 0);
    const d = dispatched[0];
    assert.equal(d.workerId, "p-1"); // delivered to the PARENT
    assert.equal(d.queueWhenBusy, true);
    assert.equal(d.origin, "context-threshold");
    assert.deepEqual(d.envelope, { kind: "context_threshold", stage: "warn90", fromWorker: "w-1", workerName: "alice", pct: 90 });
    assert.match(d.text, /alice worker'ının context'i dolmak üzere, %90'a ulaştı/);
  });

  it("a second IDLE at the same occupancy is silent (latched)", async () => {
    const { svc, dispatched, setUsed } = makeSvc();
    setUsed(90_000);
    svc.checkOnIdle("w-1");
    await flush();
    svc.checkOnIdle("w-1");
    await flush();
    assert.equal(dispatched.length, 1);
  });

  it("a context epoch reset (used=0) re-arms the warn", async () => {
    const { svc, dispatched, setUsed } = makeSvc();
    setUsed(90_000);
    svc.checkOnIdle("w-1");
    await flush();
    assert.equal(dispatched.length, 1);

    setUsed(0); // /clear or fresh session → epoch reset, latch cleared
    svc.checkOnIdle("w-1");
    await flush();
    assert.equal(dispatched.length, 1); // the reset itself notifies nothing

    setUsed(90_000);
    svc.checkOnIdle("w-1");
    await flush();
    assert.equal(dispatched.length, 2); // re-armed → fires again
  });

  it("at ≥95% it auto-suspends and dispatches the full stage (no warn)", async () => {
    const { svc, dispatched, suspended, setUsed } = makeSvc();
    setUsed(95_000); // pct 95
    svc.checkOnIdle("w-1");
    await flush();
    assert.equal(suspended.length, 1);
    assert.deepEqual(suspended[0], { id: "w-1", reason: "context_full" });
    assert.equal(dispatched.length, 1);
    const d = dispatched[0];
    assert.equal(d.workerId, "p-1");
    assert.equal(d.envelope.stage, "full");
    assert.deepEqual(d.envelope, { kind: "context_threshold", stage: "full", fromWorker: "w-1", workerName: "alice" });
    assert.match(d.text, /agent'ın context'i doldu ve durduruldu/);
  });

  it("warn and full latch independently across a rising occupancy", async () => {
    const { svc, dispatched, suspended, setUsed } = makeSvc();
    setUsed(90_000);
    svc.checkOnIdle("w-1"); // warn
    await flush();
    setUsed(95_000);
    svc.checkOnIdle("w-1"); // full + suspend (warn stays latched, not re-sent)
    await flush();
    assert.equal(suspended.length, 1);
    assert.deepEqual(dispatched.map((d) => d.envelope.stage), ["warn90", "full"]);

    // Still ≥95 on the next IDLE → both latched, nothing new.
    svc.checkOnIdle("w-1");
    await flush();
    assert.equal(dispatched.length, 2);
    assert.equal(suspended.length, 1);
  });

  it("unknown model window (limit null) is silent — fail-open", async () => {
    const { svc, dispatched, suspended, setUsed } = makeSvc({ limit: null });
    setUsed(95_000);
    svc.checkOnIdle("w-1");
    await flush();
    assert.equal(dispatched.length, 0);
    assert.equal(suspended.length, 0);
  });

  it("a worker with no parent is skipped entirely (never suspended/warned)", async () => {
    const { svc, dispatched, suspended, setUsed } = makeSvc({ parentId: null });
    setUsed(99_000); // pct 99
    svc.checkOnIdle("w-1");
    await flush();
    assert.equal(dispatched.length, 0);
    assert.equal(suspended.length, 0);
  });

  it("an unnamed worker falls back to its id in the warn body", async () => {
    const { svc, dispatched, setUsed } = makeSvc({ name: null });
    setUsed(90_000);
    svc.checkOnIdle("w-1");
    await flush();
    assert.equal(dispatched[0].envelope.workerName, "w-1");
    assert.match(dispatched[0].text, /w-1 worker'ının/);
  });
});
