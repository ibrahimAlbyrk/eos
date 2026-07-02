import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createInProcessBackend, type InProcessEnv } from "../backends/InProcessBackend.ts";
import type { ModelClient, ModelTurn } from "../../../core/src/ports/ModelClient.ts";
import type { RuntimeTool, ToolGate } from "../../../core/src/use-cases/ToolRuntime.ts";
import type { AgentEvent } from "../../../core/src/ports/AgentBackend.ts";
import type { AgentLaunchSpec } from "../../../core/src/ports/AgentBackend.ts";

// Proves a NON-claude-cli backend works end-to-end through the AgentBackend seam,
// driven by the Eos ToolRuntime, using a fake model (no API key, no billing).

function fakeModel(turns: ModelTurn[]): ModelClient {
  let i = 0;
  return { async createTurn() { return turns[Math.min(i++, turns.length - 1)]; } };
}
const allowGate: ToolGate = { async decide() { return { allow: true }; } };

function spec(prompt: string): AgentLaunchSpec {
  return { workerId: "w1", cwd: "/tmp", model: "fake-model", prompt, persistent: false, parentId: null, isOrchestrator: false };
}

function env(calls: unknown[]): InProcessEnv {
  const tools = new Map<string, RuntimeTool>([
    ["echo", { name: "echo", async execute(input) { calls.push(input); return "echoed"; } }],
  ]);
  const turns: ModelTurn[] = [
    { toolCalls: [{ callId: "c1", name: "echo", input: { v: 1 } }], stopReason: "tool_use" },
    { text: "all done", toolCalls: [], stopReason: "end_turn", usage: { inputTokens: 7, outputTokens: 3 } },
  ];
  return { model: fakeModel(turns), tools, gate: allowGate };
}

const tag = (e: AgentEvent): string =>
  e.type === "turn" ? `turn:${e.phase}`
    : e.type === "session" ? `session:${e.phase}`
    : e.type === "message" ? `msg:${e.blocks[0].type}`
    : e.type;

describe("InProcessBackend (second backend, fake model)", () => {
  it("start runs the prompt turn end-to-end, emitting canonical events via onEvent", async () => {
    const events: AgentEvent[] = [];
    const calls: unknown[] = [];
    const be = createInProcessBackend("fake-api", () => env(calls));
    const session = await be.start(spec("do it"), { onEvent: (e) => events.push(e) });
    await be.whenSettled("w1");

    assert.equal(session.handle.kind, "inproc");
    assert.ok(session.isAlive());
    assert.deepEqual(calls, [{ v: 1 }]); // the tool actually ran
    const tags = events.map(tag);
    assert.deepEqual(tags, ["session:started", "turn:started", "msg:tool_call", "msg:tool_result", "msg:text", "usage", "context", "turn:ended"]);
  });

  it("sendMessage drives a follow-up turn", async () => {
    const events: AgentEvent[] = [];
    const be = createInProcessBackend("fake-api", () => env([]));
    const session = await be.start(spec(""), { onEvent: (e) => events.push(e) });
    await be.whenSettled("w1");
    events.length = 0;
    await session.sendMessage("again");
    await be.whenSettled("w1");
    assert.ok(events.map(tag).includes("turn:ended"));
  });

  it("an unguarded loop failure (pre-call compaction throws) settles as one terminal turn:error", async () => {
    // Pre-call compaction is unguarded inside the loop; a throw there used to escape
    // runTurn with no terminal event. Piece 1's try/finally must turn it into exactly
    // one turn:error so the FSM still idles.
    const events: AgentEvent[] = [];
    const turns: ModelTurn[] = [{ text: "hi", toolCalls: [], stopReason: "end_turn" }];
    const be = createInProcessBackend("fake-api", () => ({
      model: fakeModel(turns),
      tools: new Map(),
      gate: allowGate,
      compactor: { compact() { throw new Error("compaction boom"); } },
      capabilities: { contextWindow: 1000 } as never,
    }));
    await be.start(spec("go"), { onEvent: (e) => events.push(e) });
    await be.whenSettled("w1");

    const terminals = events.filter((e) => e.type === "turn" && (e.phase === "ended" || e.phase === "error" || e.phase === "aborted"));
    assert.equal(terminals.length, 1, "exactly one terminal turn event");
    assert.equal(tag(terminals[0]), "turn:error");
  });

  it("a runTurn rejection still settles the turn with a terminal turn:error (FSM leaves WORKING)", async () => {
    // runTurn owns terminal emission via its finally. Simulate the residual failure
    // piece 2 guards: the terminal-event sink itself throws (a flaky SSE publish), so
    // runTurn's finally rejects. kickTurn's catch must emit a turn:error so the FSM
    // still idles instead of hanging WORKING. The sink throws only on the FIRST
    // terminal event (the finally's emit), then works — modelling a transient failure.
    const events: AgentEvent[] = [];
    let terminalThrows = 1;
    const onEvent = (e: AgentEvent) => {
      const isTerminal = e.type === "turn" && (e.phase === "ended" || e.phase === "error" || e.phase === "aborted");
      if (isTerminal && terminalThrows > 0) { terminalThrows--; throw new Error("sse publish failed"); }
      events.push(e);
    };
    const turns: ModelTurn[] = [{ text: "hi", toolCalls: [], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } }];
    const be = createInProcessBackend("fake-api", () => ({ model: fakeModel(turns), tools: new Map(), gate: allowGate }));
    await be.start(spec("go"), { onEvent });
    await be.whenSettled("w1");

    const terminals = events.filter((e) => e.type === "turn" && (e.phase === "ended" || e.phase === "error" || e.phase === "aborted"));
    assert.equal(terminals.length, 1, "exactly one terminal turn event was delivered");
    assert.equal(tag(terminals[0]), "turn:error", "the rejection settled as turn:error");
  });

  it("attach reconstructs a usable session; stop ends it", async () => {
    const events: AgentEvent[] = [];
    const be = createInProcessBackend("fake-api", () => env([]));
    await be.start(spec(""), { onEvent: (e) => events.push(e), onExit: () => events.push({ type: "session", phase: "ended" } as AgentEvent) });
    const s2 = be.attach("w1", { kind: "inproc", ref: "w1" });
    assert.ok(s2.isAlive());
    s2.stop();
    assert.equal(s2.isAlive(), false);
  });
});
