import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { processWorkerEvent, type ProcessWorkerEventDeps } from "../use-cases/ProcessWorkerEvent.ts";
import type { WorkerRow } from "../../../contracts/src/worker.ts";
import type { WorkerState } from "../../../contracts/src/events.ts";

interface AppendedEvent { type: string; payload: unknown }

function buildDeps(initialState: WorkerState, opts: { settling?: boolean } = {}): {
  deps: ProcessWorkerEventDeps;
  events: AppendedEvent[];
  row: { state: WorkerState };
  toolCalls: { count: number };
  worktreeDirCalls: Array<{ id: string; dir: string }>;
  forkBaseShaCalls: Array<{ id: string; sha: string }>;
  sessionIdCalls: Array<{ id: string; sessionId: string }>;
} {
  const events: AppendedEvent[] = [];
  const row = { state: initialState };
  const toolCalls = { count: 0 };
  const worktreeDirCalls: Array<{ id: string; dir: string }> = [];
  const forkBaseShaCalls: Array<{ id: string; sha: string }> = [];
  const sessionIdCalls: Array<{ id: string; sessionId: string }> = [];
  // Mutable so markSettling (driven by the Stop hook) actually opens the window
  // a subsequent jsonl event then observes — mirrors TurnSettleService.
  let settling = opts.settling ?? false;

  const workers = {
    findById: () => row as unknown as WorkerRow,
    updateState: (_id: string, next: WorkerState) => { row.state = next; },
    setTurnStartedAt: () => {},
    incrementToolCalls: () => { toolCalls.count++; },
    setWorktreeDir: (id: string, dir: string) => { worktreeDirCalls.push({ id, dir }); },
    setForkBaseSha: (id: string, sha: string) => { forkBaseShaCalls.push({ id, sha }); },
    setSessionId: (id: string, sessionId: string) => { sessionIdCalls.push({ id, sessionId }); },
  } as unknown as ProcessWorkerEventDeps["workers"];

  const eventsRepo = {
    append: (_workerId: string, _ts: number, type: string, payload: unknown) => {
      events.push({ type, payload });
      return events.length;
    },
    patchPayload: () => {},
  } as unknown as ProcessWorkerEventDeps["events"];

  const bus = {
    publish: () => {},
    subscribe: () => () => {},
  } as unknown as ProcessWorkerEventDeps["bus"];

  const deps = {
    workers,
    events: eventsRepo,
    bus,
    clock: { now: () => 1234 },
    models: { priceFor: () => ({ in: 0, out: 0, cacheRead: 0, cacheCreate: 0, cacheCreate1h: 0 }) },
    log: { info: () => {}, warn: () => {}, error: () => {}, child: () => deps.log },
    isSettling: () => settling,
    markSettling: () => { settling = true; },
  } as unknown as ProcessWorkerEventDeps;

  return { deps, events, row, toolCalls, worktreeDirCalls, forkBaseShaCalls, sessionIdCalls };
}

const stateEvents = (events: AppendedEvent[]): Array<{ state?: string; reason?: string }> =>
  events.filter((e) => e.type === "state").map((e) => e.payload as { state?: string; reason?: string });

describe("ProcessWorkerEvent.lifecycle — non-spawning phases", () => {
  for (const phase of ["ready_timeout", "ready_no_prompt", "something_else"]) {
    it(`ignores phase "${phase}"`, () => {
      const { deps, events } = buildDeps("WORKING");
      processWorkerEvent(deps, { workerId: "w1", type: "lifecycle", payload: { phase } });
      assert.deepEqual(stateEvents(events), []);
    });
  }
});

describe("ProcessWorkerEvent.lifecycle — claude_spawning worktree_dir enrichment", () => {
  it("persists the resolved worktree dir", () => {
    const { deps, worktreeDirCalls } = buildDeps("SPAWNING");
    processWorkerEvent(deps, { workerId: "w1", type: "lifecycle", payload: { phase: "claude_spawning", worktreeDir: "/repo/.eos/worktrees/eos-w1-x", branch: "eos-w1-x" } });
    assert.deepEqual(worktreeDirCalls, [{ id: "w1", dir: "/repo/.eos/worktrees/eos-w1-x" }]);
  });

  it("does not transition state on claude_spawning", () => {
    const { deps, events } = buildDeps("SPAWNING");
    processWorkerEvent(deps, { workerId: "w1", type: "lifecycle", payload: { phase: "claude_spawning", worktreeDir: "/x" } });
    assert.deepEqual(stateEvents(events), []);
  });

  it("is a no-op when claude_spawning carries no worktreeDir (plain-cwd worker)", () => {
    const { deps, worktreeDirCalls } = buildDeps("SPAWNING");
    processWorkerEvent(deps, { workerId: "w1", type: "lifecycle", payload: { phase: "claude_spawning" } });
    assert.deepEqual(worktreeDirCalls, []);
  });

  it("persists the fork base sha stamped at worktree creation", () => {
    const { deps, forkBaseShaCalls } = buildDeps("SPAWNING");
    processWorkerEvent(deps, { workerId: "w1", type: "lifecycle", payload: { phase: "claude_spawning", worktreeDir: "/x", forkBaseSha: "abc123" } });
    assert.deepEqual(forkBaseShaCalls, [{ id: "w1", sha: "abc123" }]);
  });

  it("is a no-op when forkBaseSha is missing or empty", () => {
    const { deps, forkBaseShaCalls } = buildDeps("SPAWNING");
    processWorkerEvent(deps, { workerId: "w1", type: "lifecycle", payload: { phase: "claude_spawning", worktreeDir: "/x" } });
    processWorkerEvent(deps, { workerId: "w1", type: "lifecycle", payload: { phase: "claude_spawning", worktreeDir: "/x", forkBaseSha: "" } });
    assert.deepEqual(forkBaseShaCalls, []);
  });
});

describe("ProcessWorkerEvent.lifecycle — session_captured enrichment", () => {
  it("persists the claude session id", () => {
    const { deps, sessionIdCalls } = buildDeps("SPAWNING");
    processWorkerEvent(deps, { workerId: "w1", type: "lifecycle", payload: { phase: "session_captured", sessionId: "abc-123", via: "hook:Stop" } });
    assert.deepEqual(sessionIdCalls, [{ id: "w1", sessionId: "abc-123" }]);
  });

  it("does not transition state", () => {
    const { deps, events } = buildDeps("WORKING");
    processWorkerEvent(deps, { workerId: "w1", type: "lifecycle", payload: { phase: "session_captured", sessionId: "abc-123" } });
    assert.deepEqual(stateEvents(events), []);
  });

  it("is a no-op when sessionId is missing or empty", () => {
    const { deps, sessionIdCalls } = buildDeps("WORKING");
    processWorkerEvent(deps, { workerId: "w1", type: "lifecycle", payload: { phase: "session_captured" } });
    processWorkerEvent(deps, { workerId: "w1", type: "lifecycle", payload: { phase: "session_captured", sessionId: "" } });
    assert.deepEqual(sessionIdCalls, []);
  });
});

describe("ProcessWorkerEvent.lifecycle — delivery_failed heal", () => {
  it("heals WORKING → IDLE (the eager user_message lift was a lie)", () => {
    const { deps, events, row } = buildDeps("WORKING");
    processWorkerEvent(deps, { workerId: "w1", type: "lifecycle", payload: { phase: "delivery_failed", text: "lost prompt" } });
    assert.equal(row.state, "IDLE");
    assert.deepEqual(stateEvents(events), [{ state: "IDLE", from: "WORKING", reason: "delivery_failed" }]);
  });

  it("is a no-op when already IDLE", () => {
    const { deps, events } = buildDeps("IDLE");
    processWorkerEvent(deps, { workerId: "w1", type: "lifecycle", payload: { phase: "delivery_failed" } });
    assert.deepEqual(stateEvents(events), []);
  });
});

describe("ProcessWorkerEvent.jsonl — IDLE self-heal", () => {
  it("recovers IDLE → WORKING when real JSONL lands", () => {
    const { deps, events } = buildDeps("IDLE");
    processWorkerEvent(deps, { workerId: "w1", type: "jsonl", payload: { kind: "assistant_text", text: "hi" } });
    assert.deepEqual(stateEvents(events), [{ state: "WORKING", from: "IDLE", reason: "jsonl:assistant_text" }]);
  });

  it("recovers SPAWNING → WORKING (unchanged behavior)", () => {
    const { deps, events } = buildDeps("SPAWNING");
    processWorkerEvent(deps, { workerId: "w1", type: "jsonl", payload: { kind: "tool_use", id: "T1" } });
    assert.deepEqual(stateEvents(events), [{ state: "WORKING", from: "SPAWNING", reason: "jsonl:tool_use" }]);
  });

  it("is a no-op when already WORKING", () => {
    const { deps, events } = buildDeps("WORKING");
    processWorkerEvent(deps, { workerId: "w1", type: "jsonl", payload: { kind: "assistant_text" } });
    assert.deepEqual(stateEvents(events), []);
  });
});

describe("ProcessWorkerEvent.jsonl — turn-settle suppression", () => {
  it("Stop opens a settle window so trailing JSONL does NOT re-flip IDLE → WORKING", () => {
    const { deps, events, row } = buildDeps("WORKING");
    processWorkerEvent(deps, { workerId: "w1", type: "hook", payload: { event: "Stop" } });
    assert.equal(row.state, "IDLE");
    // The just-ended turn's last assistant message lands after Stop (unordered
    // event channel) — it must not re-animate the worker.
    processWorkerEvent(deps, { workerId: "w1", type: "jsonl", payload: { kind: "assistant_text", text: "done" } });
    assert.equal(row.state, "IDLE");
    assert.deepEqual(stateEvents(events), [{ state: "IDLE", from: "WORKING", reason: "hook:Stop" }]);
  });

  it("does not recover IDLE → WORKING while settling (interrupt path)", () => {
    const { deps, events } = buildDeps("IDLE", { settling: true });
    processWorkerEvent(deps, { workerId: "w1", type: "jsonl", payload: { kind: "assistant_text" } });
    assert.deepEqual(stateEvents(events), []);
  });

  it("still heals SPAWNING → WORKING while settling (boot recovery is not suppressed)", () => {
    const { deps, events } = buildDeps("SPAWNING", { settling: true });
    processWorkerEvent(deps, { workerId: "w1", type: "jsonl", payload: { kind: "tool_use", id: "T1" } });
    assert.deepEqual(stateEvents(events), [{ state: "WORKING", from: "SPAWNING", reason: "jsonl:tool_use" }]);
  });

  it("counts trailing tool_use even when the WORKING re-flip is suppressed", () => {
    const { deps, row, toolCalls } = buildDeps("IDLE", { settling: true });
    processWorkerEvent(deps, { workerId: "w1", type: "jsonl", payload: { kind: "tool_use", id: "T1" } });
    assert.equal(row.state, "IDLE");
    assert.equal(toolCalls.count, 1);
  });
});
