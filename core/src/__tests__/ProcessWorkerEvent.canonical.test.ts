import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { processWorkerEvent, type ProcessWorkerEventDeps } from "../use-cases/ProcessWorkerEvent.ts";
import { toCanonicalEvents } from "../../../spawner/canonical-map.ts";
import type { WorkerRow } from "../../../contracts/src/worker.ts";
import type { WorkerState } from "../../../contracts/src/events.ts";

// Integration: with the real spawner translator injected, the daemon drives the
// state machine through the canonical pipeline. Worker + web are unchanged (the
// legacy event is still logged); only state-driving flips. Without the injected
// translator the legacy handlers run unchanged (the built-in kill switch).

interface AppendedEvent { type: string; payload: unknown }

function buildDeps(initialState: WorkerState, opts: { settling?: boolean; legacy?: boolean } = {}): {
  deps: ProcessWorkerEventDeps; events: AppendedEvent[]; row: { state: WorkerState }; toolCalls: { count: number };
} {
  const events: AppendedEvent[] = [];
  const row = { state: initialState };
  const toolCalls = { count: 0 };
  let settling = opts.settling ?? false;

  const workers = {
    findById: () => row as unknown as WorkerRow,
    updateState: (_id: string, next: WorkerState) => { row.state = next; },
    setTurnStartedAt: () => {},
    incrementToolCalls: () => { toolCalls.count++; },
    setWorktreeDir: () => {},
  } as unknown as ProcessWorkerEventDeps["workers"];

  const eventsRepo = {
    append: (_w: string, _t: number, type: string, payload: unknown) => { events.push({ type, payload }); return events.length; },
    patchPayload: () => {},
  } as unknown as ProcessWorkerEventDeps["events"];

  const bus = { publish: () => {}, subscribe: () => () => {} } as unknown as ProcessWorkerEventDeps["bus"];
  const log = { info: () => {}, warn: () => {}, error: () => {}, child: () => log } as unknown as ProcessWorkerEventDeps["log"];

  const deps = {
    workers, events: eventsRepo, bus,
    clock: { now: () => 1234 },
    models: { priceFor: () => ({ in: 0, out: 0, cacheRead: 0, cacheCreate: 0, cacheCreate1h: 0 }) },
    log,
    isSettling: () => settling,
    markSettling: () => { settling = true; },
    ...(opts.legacy ? {} : { toCanonical: toCanonicalEvents }),
  } as unknown as ProcessWorkerEventDeps;

  return { deps, events, row, toolCalls };
}

const states = (events: AppendedEvent[]): Array<{ state?: string; from?: string; reason?: string }> =>
  events.filter((e) => e.type === "state").map((e) => e.payload as { state?: string; from?: string; reason?: string });

describe("processWorkerEvent — canonical flip", () => {
  it("jsonl assistant_text drives IDLE → WORKING via canonical", () => {
    const { deps, events } = buildDeps("IDLE");
    processWorkerEvent(deps, { workerId: "w1", type: "jsonl", payload: { kind: "assistant_text", text: "hi" } });
    assert.deepEqual(states(events), [{ state: "WORKING", from: "IDLE", reason: "agent:text" }]);
  });

  it("jsonl tool_use heals SPAWNING → WORKING and counts the call", () => {
    const { deps, events, toolCalls } = buildDeps("SPAWNING");
    processWorkerEvent(deps, { workerId: "w1", type: "jsonl", payload: { kind: "tool_use", id: "T1", name: "Bash" } });
    assert.deepEqual(states(events), [{ state: "WORKING", from: "SPAWNING", reason: "agent:tool_call" }]);
    assert.equal(toolCalls.count, 1);
  });

  it("hook Stop → IDLE and opens settle window suppressing trailing jsonl", () => {
    const { deps, events, row } = buildDeps("WORKING");
    processWorkerEvent(deps, { workerId: "w1", type: "hook", payload: { event: "Stop", body: {} } });
    assert.equal(row.state, "IDLE");
    processWorkerEvent(deps, { workerId: "w1", type: "jsonl", payload: { kind: "assistant_text", text: "trailing" } });
    assert.equal(row.state, "IDLE");
    assert.deepEqual(states(events), [{ state: "IDLE", from: "WORKING", reason: "agent:turn_ended" }]);
  });

  it("tool_done drives IDLE → WORKING via canonical", () => {
    // tool_done (emitted alongside every PostToolUse hook) is the single source of
    // tool lifecycle; the hook itself no longer maps to a tool activity.
    const { deps, events } = buildDeps("IDLE");
    processWorkerEvent(deps, { workerId: "w1", type: "tool_done", payload: { toolName: "Edit", toolUseId: "x", result: "ok" } });
    assert.deepEqual(states(events), [{ state: "WORKING", from: "IDLE", reason: "agent:tool_finished" }]);
  });

  it("hook PostToolUse alone drives no state (lifecycle owned by tool_done)", () => {
    const { deps, events } = buildDeps("IDLE");
    processWorkerEvent(deps, { workerId: "w1", type: "hook", payload: { event: "PostToolUse", body: { tool_name: "Edit" } } });
    assert.deepEqual(states(events), []);
  });

  it("heartbeat heals SPAWNING → WORKING via canonical", () => {
    const { deps, events } = buildDeps("SPAWNING");
    processWorkerEvent(deps, { workerId: "w1", type: "heartbeat", payload: { elapsedMs: 1, quietMs: 1 } });
    assert.deepEqual(states(events), [{ state: "WORKING", from: "SPAWNING", reason: "agent:alive" }]);
  });

  it("hook Notification drives no state (parity with legacy)", () => {
    const { deps, events } = buildDeps("IDLE");
    processWorkerEvent(deps, { workerId: "w1", type: "hook", payload: { event: "Notification", body: {} } });
    assert.deepEqual(states(events), []);
  });

  it("jsonl content is persisted as a canonical agent_event row, not a legacy jsonl row", () => {
    const { deps, events } = buildDeps("IDLE");
    processWorkerEvent(deps, { workerId: "w1", type: "jsonl", payload: { kind: "assistant_text", text: "hi" } });
    const agentRows = events.filter((e) => e.type === "agent_event");
    assert.equal(agentRows.length, 1);
    assert.equal((agentRows[0].payload as { type?: string }).type, "message");
    assert.equal(events.some((e) => e.type === "jsonl"), false);
  });
});
