import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GoalLoopService, type GoalLoopDeps } from "../GoalLoopService.ts";
import type { LoopRow } from "../../../core/src/ports/LoopStateRepo.ts";
import type { GoalVerdict, GoalSpec } from "../../../contracts/src/loop.ts";

const noopLog = { debug() {}, info() {}, warn() {}, error() {}, child() { return noopLog; } };
const GOAL: GoalSpec = { summary: "g", criteria: [{ id: "c1", text: "t", verify: "exit 1" }] };
const UNMET: GoalVerdict = { met: false, criteria: [{ id: "c1", met: false, evidence: "non-zero" }], unmet: ["c1"], confidence: 1, reason: "unmet: c1" };
const MET: GoalVerdict = { met: true, criteria: [{ id: "c1", met: true, evidence: "exit 0" }], unmet: [], confidence: 1, reason: "all passed" };

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

function loop(): LoopRow {
  return {
    id: "l-1", workerId: "w-1", parentId: null, goal: GOAL, strategy: "command",
    status: "active", attempt: 0, maxAttempts: null, heldReport: null, lastReason: null,
    awaitingInput: false, progressRing: [], startedAt: 1, updatedAt: 1,
  };
}

function makeService(opts: {
  state?: string; live?: boolean; activeLoop?: LoopRow | null;
  pending?: unknown[]; peerQueued?: unknown; evaluate?: () => Promise<GoalVerdict>;
} = {}) {
  const dispatched: Array<{ workerId: string; text: string; origin: string }> = [];
  const statuses: string[] = [];
  const published: Array<{ workerId: string; status: string }> = [];
  const checks: Array<{ phase: string; outcome?: string; met?: boolean; attempt: number }> = [];
  const recorded: Array<{ workerId: string; outcome: string; met: boolean }> = [];
  const worker = { id: "w-1", state: opts.state ?? "IDLE", worktree_dir: null, branch: null };
  const deps = {
    workers: { findById: (id: string) => (id === "w-1" ? worker : null) },
    loops: {
      findActiveByWorker: () => (opts.activeLoop !== undefined ? opts.activeLoop : loop()),
      setStatus: (_id: string, s: string) => { statuses.push(s); },
      recordAttempt: () => {},
    },
    messageQueue: { listPending: () => opts.pending ?? [] },
    peerRequests: { nextQueuedFor: () => opts.peerQueued ?? null },
    strategyFor: () => ({ evaluate: opts.evaluate ?? (async () => UNMET) }),
    dispatch: async (input: { workerId: string; text: string; origin: string }) => { dispatched.push(input); return {}; },
    releaseReport: async () => ({}),
    stateHash: async () => "",
    noProgressWindow: 3,
    stopOnNoProgress: true,
    publishChange: (workerId: string, status: string) => { published.push({ workerId, status }); },
    publishCheck: (p: { phase: string; outcome?: string; met?: boolean; attempt: number }) => { checks.push(p); },
    recordCheck: (workerId: string, e: { outcome: string; met: boolean }) => { recorded.push({ workerId, ...e }); },
    renderer: { render: () => "CONTINUATION" },
    isLive: () => opts.live ?? true,
    clock: { now: () => 1 },
    log: noopLog,
  } as unknown as GoalLoopDeps;
  return { svc: new GoalLoopService(deps), dispatched, statuses, published, checks, recorded };
}

describe("GoalLoopService gate", () => {
  it("IDLE worker + active unmet loop → exactly one continuation dispatch", async () => {
    const { svc, dispatched } = makeService();
    svc.loopTickFor("w-1");
    await flush();
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].origin, "loop");
  });

  it("met loop → no dispatch, status passed", async () => {
    const { svc, dispatched, statuses } = makeService({ evaluate: async () => MET });
    svc.loopTickFor("w-1");
    await flush();
    assert.equal(dispatched.length, 0);
    assert.deepEqual(statuses, ["passed"]);
  });

  it("re-entrancy guard: a second tick while the first is in flight is dropped", async () => {
    let resolveEval: (v: GoalVerdict) => void = () => {};
    const { svc, dispatched } = makeService({ evaluate: () => new Promise((r) => { resolveEval = r; }) });
    svc.loopTickFor("w-1"); // enters, awaits the deferred evaluate
    svc.loopTickFor("w-1"); // ticking guard → dropped
    resolveEval(UNMET);
    await flush();
    assert.equal(dispatched.length, 1);
  });

  it("STARVATION: a queued message blocks the loop tick (queue precedes loop)", async () => {
    const { svc, dispatched } = makeService({ pending: [{ id: 1 }] });
    svc.loopTickFor("w-1");
    await flush();
    assert.equal(dispatched.length, 0);
  });

  it("a waiting peer request blocks the loop tick (peer precedes loop)", async () => {
    const { svc, dispatched } = makeService({ peerQueued: { requestId: "r1" } });
    svc.loopTickFor("w-1");
    await flush();
    assert.equal(dispatched.length, 0);
  });

  it("non-IDLE / dead / no-loop workers never tick", async () => {
    for (const opts of [{ state: "WORKING" }, { live: false }, { activeLoop: null }]) {
      const { svc, dispatched } = makeService(opts);
      svc.loopTickFor("w-1");
      await flush();
      assert.equal(dispatched.length, 0);
    }
  });

  it("publishes loop:change after a continued tick (status active)", async () => {
    const { svc, published } = makeService();
    svc.loopTickFor("w-1");
    await flush();
    assert.deepEqual(published, [{ workerId: "w-1", status: "active" }]);
  });

  it("publishes loop:change after a met tick (status passed)", async () => {
    const { svc, published } = makeService({ evaluate: async () => MET });
    svc.loopTickFor("w-1");
    await flush();
    assert.deepEqual(published, [{ workerId: "w-1", status: "passed" }]);
  });

  it("does NOT publish when the tick is a no-op (no active loop)", async () => {
    const { svc, published } = makeService({ activeLoop: null });
    svc.loopTickFor("w-1");
    await flush();
    assert.equal(published.length, 0);
  });

  it("transient: a continued tick emits loop:check started → verdict(continued)", async () => {
    const { svc, checks } = makeService();
    svc.loopTickFor("w-1");
    await flush();
    assert.equal(checks[0].phase, "started");
    const verdict = checks[checks.length - 1];
    assert.equal(verdict.phase, "verdict");
    assert.equal(verdict.outcome, "continued");
    assert.equal(verdict.met, false);
    assert.equal(verdict.attempt, 1);
  });

  it("durable: exactly ONE loop_check is recorded per attempt outcome", async () => {
    const { svc, recorded } = makeService();
    svc.loopTickFor("w-1");
    await flush();
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].workerId, "w-1");
    assert.equal(recorded[0].outcome, "continued");
    assert.equal(recorded[0].met, false);
  });

  it("durable: a met tick records a released verdict (and no continuation)", async () => {
    const { svc, recorded, checks } = makeService({ evaluate: async () => MET });
    svc.loopTickFor("w-1");
    await flush();
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].outcome, "released");
    assert.equal(recorded[0].met, true);
    assert.equal(checks[checks.length - 1].outcome, "released");
  });

  it("no-op tick (no active loop) emits no loop:check and records nothing", async () => {
    const { svc, checks, recorded } = makeService({ activeLoop: null });
    svc.loopTickFor("w-1");
    await flush();
    assert.equal(checks.length, 0);
    assert.equal(recorded.length, 0);
  });
});
