import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createInMemoryEventBus } from "../../../infra/src/eventbus/InMemoryEventBus.ts";
import { GoalLoopService, type GoalLoopDeps } from "../GoalLoopService.ts";
import type { LoopRow } from "../../../core/src/ports/LoopStateRepo.ts";
import type { GoalVerdict, GoalSpec } from "../../../contracts/src/loop.ts";

const noopLog = { debug() {}, info() {}, warn() {}, error() {}, child() { return noopLog; } };
const GOAL: GoalSpec = { summary: "g", criteria: [{ id: "c1", text: "t", verify: "exit 1" }] };
const UNMET: GoalVerdict = { met: false, criteria: [{ id: "c1", met: false, evidence: "x" }], unmet: ["c1"], confidence: 1, reason: "unmet" };
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

function build() {
  const dispatched: unknown[] = [];
  const worker = { id: "w-1", state: "IDLE", worktree_dir: null, branch: null };
  const loop: LoopRow = {
    id: "l-1", workerId: "w-1", parentId: null, goal: GOAL, strategy: "command",
    status: "active", attempt: 0, maxAttempts: null, heldReport: null, lastReason: null,
    awaitingInput: false, progressRing: [], startedAt: 1, updatedAt: 1,
  };
  const deps = {
    workers: { findById: (id: string) => (id === "w-1" ? worker : null) },
    loops: { findActiveByWorker: () => loop, setStatus: () => {}, recordAttempt: () => {}, setHeldReport: () => {} },
    messageQueue: { listPending: () => [] },
    peerRequests: { nextQueuedFor: () => null },
    strategyFor: () => ({ evaluate: async () => UNMET }),
    dispatch: async (input: unknown) => { dispatched.push(input); return {}; },
    releaseReport: async () => ({}),
    stateHash: async () => "",
    noProgressWindow: 3,
    stopOnNoProgress: true,
    publishChange: () => {},
    renderer: { render: () => "CONTINUATION" },
    isLive: () => true,
    clock: { now: () => 1 },
    log: noopLog,
  } as unknown as GoalLoopDeps;

  const svc = new GoalLoopService(deps);
  const bus = createInMemoryEventBus();
  // The exact daemon subscriber predicate.
  bus.subscribe("loop:change", (msg) => {
    const p = msg.payload as { workerId?: string; status?: string };
    if (p?.workerId && p.status === "active") svc.loopTickFor(p.workerId);
  });
  return { bus, dispatched };
}

describe("loop:change subscriber (dormant-loop race fix)", () => {
  it("an already-IDLE worker + loop:change{active} → the goal-check fires (no dormancy)", async () => {
    const { bus, dispatched } = build();
    bus.publish("loop:change", { workerId: "w-1", status: "active" });
    await flush();
    assert.equal(dispatched.length, 1);
  });

  it("a republish (or concurrent IDLE drain) does NOT double-tick", async () => {
    const { bus, dispatched } = build();
    bus.publish("loop:change", { workerId: "w-1", status: "active" });
    bus.publish("loop:change", { workerId: "w-1", status: "active" });   // republish while the first tick is in flight
    await flush();
    assert.equal(dispatched.length, 1);
  });

  it("a terminal status (passed/exhausted/stopped) does NOT tick", async () => {
    const { bus, dispatched } = build();
    bus.publish("loop:change", { workerId: "w-1", status: "passed" });
    bus.publish("loop:change", { workerId: "w-1", status: "stopped" });
    await flush();
    assert.equal(dispatched.length, 0);
  });
});
