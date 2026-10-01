import { describe, it, expect } from "vitest";
import { buildBlocks } from "./messageParser.js";

const agentUse = (id, ts, input = { description: id }) =>
  ({ type: "jsonl", ts, payload: { kind: "tool_use", id, name: "Agent", input, tsTranscript: ts } });
const agentPulse = (id, ts, input = { description: id }) =>
  ({ type: "tool_running", ts, payload: { toolName: "Agent", toolUseId: id, input } });
const innerPulse = (id, ts, parent) =>
  ({ type: "tool_running", ts, payload: { toolName: "Read", toolUseId: id, input: { file_path: "/x" }, parentAgentToolUseId: parent } });
const toolDone = (id, ts, result = "ok", toolName = "Agent") =>
  ({ type: "tool_done", ts, payload: { toolName, toolUseId: id, result } });
const toolResult = (id, ts, text) =>
  ({ type: "jsonl", ts, payload: { kind: "tool_result", toolUseId: id, text, isError: false, tsTranscript: ts } });

const runs = (blocks) => blocks.filter((b) => b.kind === "agentRun");

describe("buildBlocks subagents before their tool_use flushes (hook-only window)", () => {
  it("opens a running agentRun from the Agent pulse alone", () => {
    const blocks = buildBlocks([agentPulse("AG", 100, { description: "Git özeti", prompt: "read only" })]);
    expect(runs(blocks)).toHaveLength(1);
    expect(runs(blocks)[0]).toMatchObject({ toolUseId: "AG", description: "Git özeti", prompt: "read only", status: "running", ts: 100 });
    expect(blocks.some((b) => b.kind === "tool")).toBe(false);
  });

  it("hangs inner tools under the pulse-only agent, never under themselves", () => {
    const blocks = buildBlocks([agentPulse("AG", 100), innerPulse("R1", 101, "AG")]);
    expect(runs(blocks)[0].tools.map((t) => t.id)).toEqual(["R1"]);
    expect(blocks.some((b) => b.kind === "tool")).toBe(false);
  });

  it("keeps one agentRun with the same id once the tool_use flushes", () => {
    const blocks = buildBlocks([agentPulse("AG", 100), innerPulse("R1", 101, "AG"), agentUse("AG", 99)]);
    expect(runs(blocks).map((r) => r.toolUseId)).toEqual(["AG"]);
    expect(runs(blocks)[0].tools.map((t) => t.id)).toEqual(["R1"]);
  });

  it("closes a pulse-only agent on its tool_done, with its end time and result", () => {
    const blocks = buildBlocks([agentPulse("AG", 100), toolDone("AG", 134, "the report")]);
    expect(runs(blocks)[0]).toMatchObject({ status: "completed", endTs: 134, result: "the report" });
  });

  it("leaves a nested Agent (one with a parent) as an inner tool", () => {
    const nested = { type: "tool_running", ts: 101, payload: { toolName: "Agent", toolUseId: "N1", input: {}, parentAgentToolUseId: "AG" } };
    const blocks = buildBlocks([agentPulse("AG", 100), nested]);
    expect(runs(blocks).map((r) => r.toolUseId)).toEqual(["AG"]);
    expect(runs(blocks)[0].tools.map((t) => t.id)).toEqual(["N1"]);
  });
});

describe("buildBlocks agentRun profile", () => {
  const profile = (callId, ts, extra) => ({ type: "agent_event", ts, payload: { type: "subagent_profile", callId, ...extra } });

  it("takes the model and effort the subagent actually ran on, newest first", () => {
    const events = [
      agentUse("AG", 100, { description: "x", model: "sonnet" }),
      profile("AG", 101, { model: "claude-haiku-4-5" }),
      profile("AG", 102, { model: "claude-haiku-4-5", effort: "high" }),
    ];
    expect(runs(buildBlocks(events))[0]).toMatchObject({ model: "claude-haiku-4-5", effort: "high" });
  });

  it("falls back to the requested model, with no effort, for events that predate profiles", () => {
    const [run] = runs(buildBlocks([agentUse("AG", 100, { description: "x", model: "opus" })]));
    expect(run).toMatchObject({ model: "opus", effort: null });
  });
});

describe("buildBlocks agentRun timing", () => {
  it("ends a foreground agent at its tool_result", () => {
    const [run] = runs(buildBlocks([agentUse("AG", 100), toolResult("AG", 134, "done")]));
    expect(run).toMatchObject({ status: "completed", endTs: 134, usage: null });
  });

  it("has no end while running", () => {
    expect(runs(buildBlocks([agentUse("AG", 100)]))[0].endTs).toBe(null);
  });

  it("carries a background agent's completion usage and end", () => {
    const events = [
      agentUse("AG", 100),
      { type: "agent_event", ts: 101, payload: { type: "subagent_started", callId: "AG", agentId: "a1", background: true } },
      toolResult("AG", 101, "launch stub"),
      { type: "agent_event", ts: 160, payload: { type: "subagent_completed", agentId: "a1", status: "completed", result: "out", usage: { durationMs: 58000 } } },
    ];
    const [run] = runs(buildBlocks(events));
    expect(run).toMatchObject({ status: "completed", result: "out", endTs: 160, usage: { durationMs: 58000 } });
  });
});
