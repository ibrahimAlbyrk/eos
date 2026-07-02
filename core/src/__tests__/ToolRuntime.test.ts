import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runTurn, type ToolRuntimeDeps, type RuntimeTool, type ToolGate } from "../use-cases/ToolRuntime.ts";
import type { ModelClient, ModelTurn } from "../ports/ModelClient.ts";
import type { AgentEvent } from "../../../contracts/src/canonical.ts";

function fakeModel(turns: ModelTurn[]): ModelClient {
  let i = 0;
  return { async createTurn() { return turns[Math.min(i++, turns.length - 1)]; } };
}
const allowGate: ToolGate = { async decide() { return { allow: true }; } };
const denyGate: ToolGate = { async decide() { return { allow: false, message: "nope" }; } };

const callTurn: ModelTurn = { toolCalls: [{ callId: "c1", name: "echo", input: { x: 1 } }], stopReason: "tool_use" };
const endTurn: ModelTurn = { text: "done", toolCalls: [], stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } };

function echoTool(calls: unknown[]): Map<string, RuntimeTool> {
  return new Map([["echo", { name: "echo", async execute(input) { calls.push(input); return "echoed:" + JSON.stringify(input); } }]]);
}

const tag = (e: AgentEvent): string =>
  e.type === "turn" ? `turn:${e.phase}`
    : e.type === "message" ? `msg:${e.blocks[0].type}`
    : e.type;

describe("ToolRuntime.runTurn", () => {
  it("happy path: executes a gated tool then ends the turn, emitting canonical events", async () => {
    const events: AgentEvent[] = [];
    const calls: unknown[] = [];
    await runTurn({ model: fakeModel([callTurn, endTurn]), tools: echoTool(calls), gate: allowGate, emit: (e) => events.push(e) }, [{ role: "user", content: "hi" }]);
    const tags = events.map(tag);
    assert.deepEqual(tags, ["turn:started", "msg:tool_call", "msg:tool_result", "msg:text", "usage", "context", "turn:ended"]);
    assert.deepEqual(calls, [{ x: 1 }]);
    const tr = events.find((e): e is Extract<AgentEvent, { type: "message" }> => e.type === "message" && e.blocks[0].type === "tool_result");
    const block = tr!.blocks[0];
    assert.equal(block.type === "tool_result" && block.content, 'echoed:{"x":1}');
    assert.equal(block.type === "tool_result" && block.isError, false);
  });

  it("denied tool is NOT executed; an error tool_result is fed back", async () => {
    const events: AgentEvent[] = [];
    const calls: unknown[] = [];
    await runTurn({ model: fakeModel([callTurn, endTurn]), tools: echoTool(calls), gate: denyGate, emit: (e) => events.push(e) }, []);
    assert.deepEqual(calls, []); // gate denied → tool never ran
    const tr = events.find((e): e is Extract<AgentEvent, { type: "message" }> => e.type === "message" && e.blocks[0].type === "tool_result")!;
    const block = tr.blocks[0];
    assert.equal(block.type === "tool_result" && block.isError, true);
    assert.equal(block.type === "tool_result" && block.content, "nope");
  });

  it("unknown tool yields an error result, not a crash", async () => {
    const events: AgentEvent[] = [];
    const turn: ModelTurn = { toolCalls: [{ callId: "c1", name: "missing", input: {} }], stopReason: "tool_use" };
    await runTurn({ model: fakeModel([turn, endTurn]), tools: new Map(), gate: allowGate, emit: (e) => events.push(e) }, []);
    const tr = events.find((e): e is Extract<AgentEvent, { type: "message" }> => e.type === "message" && e.blocks[0].type === "tool_result")!;
    const block = tr.blocks[0];
    assert.equal(block.type === "tool_result" && block.isError, true);
    assert.match(block.type === "tool_result" ? block.content : "", /unknown tool: missing/);
  });

  it("a throwing tool becomes an error result", async () => {
    const events: AgentEvent[] = [];
    const tools = new Map<string, RuntimeTool>([["boom", { name: "boom", async execute() { throw new Error("kaboom"); } }]]);
    const turn: ModelTurn = { toolCalls: [{ callId: "c1", name: "boom", input: {} }], stopReason: "tool_use" };
    await runTurn({ model: fakeModel([turn, endTurn]), tools, gate: allowGate, emit: (e) => events.push(e) }, []);
    const tr = events.find((e): e is Extract<AgentEvent, { type: "message" }> => e.type === "message" && e.blocks[0].type === "tool_result")!;
    assert.match(tr.blocks[0].type === "tool_result" ? tr.blocks[0].content : "", /kaboom/);
  });

  it("max-iterations guard aborts a runaway loop", async () => {
    const events: AgentEvent[] = [];
    await runTurn({ model: fakeModel([callTurn]), tools: echoTool([]), gate: allowGate, emit: (e) => events.push(e), maxIterations: 3 }, []);
    const last = events[events.length - 1];
    assert.equal(last.type === "turn" && last.phase, "aborted");
    assert.equal(last.type === "turn" && last.reason, "max_iterations");
  });

  it("respects an abort signal before the first round-trip", async () => {
    const events: AgentEvent[] = [];
    let called = false;
    const model: ModelClient = { async createTurn() { called = true; return endTurn; } };
    await runTurn({ model, tools: new Map(), gate: allowGate, emit: (e) => events.push(e), signal: { aborted: true } }, []);
    assert.equal(called, false);
    assert.equal(events.map(tag).includes("turn:aborted"), true);
  });

  it("surfaces a model error as turn:error", async () => {
    const events: AgentEvent[] = [];
    const model: ModelClient = { async createTurn() { throw new Error("api down"); } };
    await runTurn({ model, tools: new Map(), gate: allowGate, emit: (e) => events.push(e) }, []);
    const last = events[events.length - 1];
    assert.equal(last.type === "turn" && last.phase, "error");
  });

  it("stamps spawnsSubagent on a subagent-spawning tool's call block and threads its callId into execute", async () => {
    const events: AgentEvent[] = [];
    let seenCtx: { callId: string } | undefined;
    const tools = new Map<string, RuntimeTool>([
      ["Task", { name: "Task", spawnsSubagent: true, async execute(_input, ctx) { seenCtx = ctx; return "sub result"; } }],
    ]);
    const turn: ModelTurn = { toolCalls: [{ callId: "task-1", name: "Task", input: { subagent_type: "x" } }], stopReason: "tool_use" };
    await runTurn({ model: fakeModel([turn, endTurn]), tools, gate: allowGate, emit: (e) => events.push(e) }, []);
    const tc = events.find((e): e is Extract<AgentEvent, { type: "message" }> => e.type === "message" && e.blocks[0].type === "tool_call")!;
    const block = tc.blocks[0];
    assert.equal(block.type === "tool_call" && block.spawnsSubagent, true);
    assert.deepEqual(seenCtx, { callId: "task-1" });
  });

  it("does NOT stamp spawnsSubagent on an ordinary tool", async () => {
    const events: AgentEvent[] = [];
    await runTurn({ model: fakeModel([callTurn, endTurn]), tools: echoTool([]), gate: allowGate, emit: (e) => events.push(e) }, []);
    const tc = events.find((e): e is Extract<AgentEvent, { type: "message" }> => e.type === "message" && e.blocks[0].type === "tool_call")!;
    assert.equal(tc.blocks[0].type === "tool_call" && tc.blocks[0].spawnsSubagent, undefined);
  });

  it("a mid-stream abort (stopReason:error, error:'aborted') ends as turn:aborted, not turn:error (m1)", async () => {
    const events: AgentEvent[] = [];
    const model: ModelClient = { async createTurn() { return { toolCalls: [], stopReason: "error", error: "aborted" }; } };
    await runTurn({ model, tools: new Map(), gate: allowGate, emit: (e) => events.push(e) }, []);
    const last = events[events.length - 1];
    assert.equal(last.type === "turn" && last.phase, "aborted");
    assert.equal(last.type === "turn" && last.reason, "interrupted");
    assert.equal(events.some((e) => e.type === "turn" && e.phase === "error"), false, "an interrupt is not surfaced as a turn error");
  });
});
