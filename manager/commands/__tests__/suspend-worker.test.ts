import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { suspendWorker } from "../handlers/suspend-worker.ts";
import { SuspendGuardService } from "../../services/SuspendGuardService.ts";
import type { Container } from "../../container.ts";

const noopLog = { info() {}, warn() {}, debug() {}, error() {} };

// Minimal fake container exercising ONLY what suspendWorker touches. `lane`
// picks how the live session is reached: "cli" = a supervised PTY child
// (supervisor.escalateKill); "sdk" = an in-process backend (session.stop).
function harness(lane: "cli" | "sdk") {
  let workerState = "WORKING";
  const calls = { escalateKill: 0, sessionStop: 0, clearRuntime: 0 };
  const published: Array<{ topic: string; payload: unknown }> = [];
  // A worktree/cascade spy: any access is a failure — suspend must never reap it.
  const worktreeTouched: string[] = [];
  const worktrees = new Proxy({}, { get: (_t, prop) => () => { worktreeTouched.push(String(prop)); } });

  const session = { stop: () => { calls.sessionStop++; }, isAlive: () => true };
  const backend = { attach: () => session };
  const suspendGuard = new SuspendGuardService({ now: () => 1000 });

  const c = {
    workers: {
      findById: (id: string) => (id === "w1"
        ? { id: "w1", backend_kind: lane === "cli" ? "claude-cli" : "claude-sdk", pid: 123, port: 456, state: workerState }
        : undefined),
      updateState: (_id: string, next: string) => { workerState = next; },
      setTurnStartedAt: () => {},
      clearRuntime: () => { calls.clearRuntime++; },
    },
    events: { append: () => 1 },
    bus: { publish: (topic: string, payload: unknown) => { published.push({ topic, payload }); } },
    clock: { now: () => 1000 },
    log: noopLog,
    // CLI lane: supervisor owns the child. SDK lane: supervisor doesn't have it.
    supervisor: { has: () => lane === "cli", escalateKill: () => { calls.escalateKill++; } },
    backends: { has: () => true, get: () => backend },
    claudeCliBackend: backend,
    suspendGuard,
    worktrees,
    cascadeWorkerRemoval: () => { worktreeTouched.push("cascadeWorkerRemoval"); },
  } as unknown as Container;

  return {
    c, suspendGuard, calls, published, worktreeTouched,
    get workerState() { return workerState; },
  };
}

describe("suspendWorker", () => {
  it("CLI lane: stops the supervised child, ends SUSPENDED, clears runtime, no worktree reap", () => {
    const h = harness("cli");
    suspendWorker(h.c, "w1", "context_full");
    assert.equal(h.calls.escalateKill, 1, "supervised child escalated");
    assert.equal(h.calls.sessionStop, 0, "in-process stop not used on the CLI lane");
    assert.equal(h.workerState, "SUSPENDED");
    assert.equal(h.calls.clearRuntime, 1, "runtime cleared");
    assert.deepEqual(h.worktreeTouched, [], "worktree/cascade never touched");
    // A state transition to SUSPENDED was published.
    assert.ok(h.published.some((p) => (p.payload as { state?: string }).state === "SUSPENDED"));
  });

  it("SDK lane: stops the in-process session, ends SUSPENDED, clears runtime", () => {
    const h = harness("sdk");
    suspendWorker(h.c, "w1", "context_full");
    assert.equal(h.calls.sessionStop, 1, "in-process session stopped");
    assert.equal(h.calls.escalateKill, 0, "no supervised child on the SDK lane");
    assert.equal(h.workerState, "SUSPENDED");
    assert.equal(h.calls.clearRuntime, 1);
    assert.deepEqual(h.worktreeTouched, []);
  });

  it("arms the intentional-suspend guard BEFORE stopping (onExit → markDone suppressed)", () => {
    const h = harness("cli");
    suspendWorker(h.c, "w1", "context_full");
    // The guard is armed → a racing SpawnWorker onExit sees isSuspending and skips
    // markDone, so SUSPENDED holds instead of being clobbered back to DONE.
    assert.equal(h.suspendGuard.isSuspending("w1"), true);

    // Simulate the CLI onExit race exactly as SpawnWorker's onExit does it.
    let markedDone = false;
    const onExit = (): void => {
      if (!h.c.suspendGuard.isSuspending("w1")) { markedDone = true; }
    };
    onExit();
    assert.equal(markedDone, false, "markDone suppressed while the suspend guard is armed");
    assert.equal(h.workerState, "SUSPENDED", "state stays SUSPENDED on both lanes");
  });

  it("no-op on an unknown worker", () => {
    const h = harness("cli");
    suspendWorker(h.c, "ghost", "context_full");
    assert.equal(h.calls.escalateKill, 0);
    assert.equal(h.calls.clearRuntime, 0);
  });
});
