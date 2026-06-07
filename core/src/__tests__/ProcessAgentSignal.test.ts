import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { processAgentSignal } from "../use-cases/ProcessAgentSignal.ts";
import type { ProcessWorkerEventDeps } from "../use-cases/ProcessWorkerEvent.ts";
import type { WorkerRow } from "../../../contracts/src/worker.ts";
import type { WorkerState } from "../../../contracts/src/events.ts";
import type { AgentEvent, ContentBlock } from "../../../contracts/src/canonical.ts";
import type { ModelPrice } from "../domain/value-objects.ts";
import type { UsageDelta } from "../ports/WorkerRepo.ts";

interface AppendedEvent { type: string; payload: unknown }

function buildDeps(
  initialState: WorkerState,
  opts: { settling?: boolean; price?: ModelPrice; model?: string | null } = {},
): {
  deps: ProcessWorkerEventDeps;
  events: AppendedEvent[];
  row: { state: WorkerState; model: string | null };
  toolCalls: { count: number };
  deltas: UsageDelta[];
  logs: Array<{ level: string; msg: string }>;
} {
  const events: AppendedEvent[] = [];
  const row = { state: initialState, model: opts.model === undefined ? "opus" : opts.model };
  const toolCalls = { count: 0 };
  const deltas: UsageDelta[] = [];
  const logs: Array<{ level: string; msg: string }> = [];
  let settling = opts.settling ?? false;

  const workers = {
    findById: () => row as unknown as WorkerRow,
    updateState: (_id: string, next: WorkerState) => { row.state = next; },
    setTurnStartedAt: () => {},
    incrementToolCalls: () => { toolCalls.count++; },
    setWorktreeDir: () => {},
    addUsage: (_id: string, d: UsageDelta) => { deltas.push(d); },
  } as unknown as ProcessWorkerEventDeps["workers"];

  const eventsRepo = {
    append: (_w: string, _t: number, type: string, payload: unknown) => { events.push({ type, payload }); return events.length; },
    patchPayload: () => {},
  } as unknown as ProcessWorkerEventDeps["events"];

  const bus = { publish: () => {}, subscribe: () => () => {} } as unknown as ProcessWorkerEventDeps["bus"];
  const log = {
    info: (msg: string) => { logs.push({ level: "info", msg }); },
    warn: (msg: string) => { logs.push({ level: "warn", msg }); },
    error: (msg: string) => { logs.push({ level: "error", msg }); },
    child: () => log,
  } as unknown as ProcessWorkerEventDeps["log"];

  const deps = {
    workers,
    events: eventsRepo,
    bus,
    clock: { now: () => 1234 },
    models: { priceFor: () => opts.price ?? { in: 0, out: 0, cacheRead: 0, cacheCreate: 0, cacheCreate1h: 0 } },
    log,
    isSettling: () => settling,
    markSettling: () => { settling = true; },
  } as unknown as ProcessWorkerEventDeps;

  return { deps, events, row, toolCalls, deltas, logs };
}

const states = (events: AppendedEvent[]): Array<{ state?: string; from?: string; reason?: string }> =>
  events.filter((e) => e.type === "state").map((e) => e.payload as { state?: string; from?: string; reason?: string });

const message = (block: ContentBlock): AgentEvent => ({ type: "message", role: "assistant", blocks: [block] });

describe("ProcessAgentSignal — message blocks (mirror legacy jsonl)", () => {
  it("text recovers IDLE → WORKING", () => {
    const { deps, events } = buildDeps("IDLE");
    processAgentSignal(deps, "w1", message({ type: "text", text: "hi" }));
    assert.deepEqual(states(events), [{ state: "WORKING", from: "IDLE", reason: "agent:text" }]);
  });

  it("text recovers SPAWNING → WORKING", () => {
    const { deps, events } = buildDeps("SPAWNING");
    processAgentSignal(deps, "w1", message({ type: "reasoning", text: "hmm" }));
    assert.deepEqual(states(events), [{ state: "WORKING", from: "SPAWNING", reason: "agent:reasoning" }]);
  });

  it("is a no-op when already WORKING", () => {
    const { deps, events } = buildDeps("WORKING");
    processAgentSignal(deps, "w1", message({ type: "text", text: "x" }));
    assert.deepEqual(states(events), []);
  });

  it("does not recover IDLE → WORKING while settling", () => {
    const { deps, events } = buildDeps("IDLE", { settling: true });
    processAgentSignal(deps, "w1", message({ type: "text", text: "x" }));
    assert.deepEqual(states(events), []);
  });

  it("tool_call heals SPAWNING → WORKING and counts the call", () => {
    const { deps, events, toolCalls } = buildDeps("SPAWNING");
    processAgentSignal(deps, "w1", message({ type: "tool_call", callId: "t1", name: "Bash", input: {} }));
    assert.deepEqual(states(events), [{ state: "WORKING", from: "SPAWNING", reason: "agent:tool_call" }]);
    assert.equal(toolCalls.count, 1);
  });

  it("counts a trailing tool_call even when the WORKING re-flip is suppressed", () => {
    const { deps, row, toolCalls } = buildDeps("IDLE", { settling: true });
    processAgentSignal(deps, "w1", message({ type: "tool_call", callId: "t1", name: "Bash", input: {} }));
    assert.equal(row.state, "IDLE");
    assert.equal(toolCalls.count, 1);
  });

  it("tool_result drives no state change", () => {
    const { deps, events } = buildDeps("IDLE");
    processAgentSignal(deps, "w1", { type: "message", role: "tool", blocks: [{ type: "tool_result", callId: "t1", isError: false, content: "ok" }] });
    assert.deepEqual(states(events), []);
  });
});

describe("ProcessAgentSignal — turn boundaries (mirror Stop / interrupt)", () => {
  it("turn ended → IDLE and opens settle window suppressing trailing text", () => {
    const { deps, events, row } = buildDeps("WORKING");
    processAgentSignal(deps, "w1", { type: "turn", phase: "ended" });
    assert.equal(row.state, "IDLE");
    processAgentSignal(deps, "w1", message({ type: "text", text: "trailing" }));
    assert.equal(row.state, "IDLE");
    assert.deepEqual(states(events), [{ state: "IDLE", from: "WORKING", reason: "agent:turn_ended" }]);
  });

  it("turn started recovers IDLE → WORKING", () => {
    const { deps, events } = buildDeps("IDLE");
    processAgentSignal(deps, "w1", { type: "turn", phase: "started" });
    assert.deepEqual(states(events), [{ state: "WORKING", from: "IDLE", reason: "agent:turn_started" }]);
  });

  it("turn aborted → IDLE", () => {
    const { deps, row } = buildDeps("WORKING");
    processAgentSignal(deps, "w1", { type: "turn", phase: "aborted", reason: "interrupt" });
    assert.equal(row.state, "IDLE");
  });
});

describe("ProcessAgentSignal — activity (mirror PostToolUse / heartbeat)", () => {
  it("tool_finished → WORKING when not settling", () => {
    const { deps, events } = buildDeps("IDLE");
    processAgentSignal(deps, "w1", { type: "activity", kind: "tool_finished", callId: "t1" });
    assert.deepEqual(states(events), [{ state: "WORKING", from: "IDLE", reason: "agent:tool_finished" }]);
  });

  it("tool_finished suppressed while settling", () => {
    const { deps, events } = buildDeps("IDLE", { settling: true });
    processAgentSignal(deps, "w1", { type: "activity", kind: "tool_finished", callId: "t1" });
    assert.deepEqual(states(events), []);
  });

  it("alive recovers SPAWNING → WORKING", () => {
    const { deps, events } = buildDeps("SPAWNING");
    processAgentSignal(deps, "w1", { type: "activity", kind: "alive" });
    assert.deepEqual(states(events), [{ state: "WORKING", from: "SPAWNING", reason: "agent:alive" }]);
  });

  it("alive is a no-op when WORKING and when settling", () => {
    const a = buildDeps("WORKING");
    processAgentSignal(a.deps, "w1", { type: "activity", kind: "alive" });
    assert.deepEqual(states(a.events), []);
    const b = buildDeps("IDLE", { settling: true });
    processAgentSignal(b.deps, "w1", { type: "activity", kind: "alive" });
    assert.deepEqual(states(b.events), []);
  });

  it("tool_started never drives state", () => {
    const { deps, events, toolCalls } = buildDeps("IDLE");
    processAgentSignal(deps, "w1", { type: "activity", kind: "tool_started", callId: "t1" });
    assert.deepEqual(states(events), []);
    assert.equal(toolCalls.count, 0);
  });
});

describe("ProcessAgentSignal — session lifecycle", () => {
  it("session ended → ENDING", () => {
    const { deps, events } = buildDeps("WORKING");
    processAgentSignal(deps, "w1", { type: "session", phase: "ended", outcome: "success" });
    assert.deepEqual(states(events), [{ state: "ENDING", from: "WORKING", reason: "agent:session_ended" }]);
  });

  it("session started / ready carry no transition", () => {
    const { deps, events } = buildDeps("SPAWNING");
    processAgentSignal(deps, "w1", { type: "session", phase: "started" });
    processAgentSignal(deps, "w1", { type: "session", phase: "ready" });
    assert.deepEqual(states(events), []);
  });
});

describe("ProcessAgentSignal — usage (mirror legacy cost handler)", () => {
  it("computes cost including 1h cache writes", () => {
    const { deps, deltas } = buildDeps("WORKING", { price: { in: 3, out: 15, cacheRead: 0.3, cacheCreate: 3.75, cacheCreate1h: 6 } });
    processAgentSignal(deps, "w1", {
      type: "usage",
      usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: { "1h": 1_000_000 }, model: "sonnet" },
    });
    // 1M input × $3 + 1M cache1h × $6 = $9
    assert.equal(deltas[0].costUsd, 9);
  });

  it("records 0 and logs error when price yields NaN", () => {
    const { deps, deltas, logs } = buildDeps("WORKING", { price: { in: NaN, out: NaN, cacheRead: NaN, cacheCreate: NaN, cacheCreate1h: NaN } });
    processAgentSignal(deps, "w1", { type: "usage", usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: {}, model: "opus" } });
    assert.equal(deltas[0].costUsd, 0);
    assert.equal(logs.filter((l) => l.level === "error").length, 1);
  });

  it("warns and falls back to opus when no model on event or row", () => {
    const { deps, logs } = buildDeps("WORKING", { price: { in: 1, out: 1, cacheRead: 0, cacheCreate: 0, cacheCreate1h: 0 }, model: null });
    processAgentSignal(deps, "w1", { type: "usage", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: {} } });
    assert.equal(logs.filter((l) => l.level === "warn").length, 1);
  });
});
