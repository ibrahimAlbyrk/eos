import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { selectSubagentRows } from "../subagent-events.ts";
import type { WorkerEventRow } from "../../../contracts/src/events.ts";

let nextId = 1;
const row = (type: string, payload: unknown): WorkerEventRow =>
  ({ id: nextId++, ts: nextId * 10, type, payload: JSON.stringify(payload) }) as unknown as WorkerEventRow;

const agentCall = (callId: string) =>
  row("agent_event", { type: "message", role: "assistant", blocks: [{ type: "tool_call", callId, name: "Agent", spawnsSubagent: true, input: {} }] });
const toolCall = (callId: string, name = "Read") =>
  row("agent_event", { type: "message", role: "assistant", blocks: [{ type: "tool_call", callId, name, input: {} }] });
const toolResult = (callId: string) =>
  row("agent_event", { type: "message", role: "tool", blocks: [{ type: "tool_result", callId, content: "ok" }] });
const innerStart = (callId: string, parentCallId: string) =>
  row("agent_event", { type: "activity", kind: "tool_started", callId, toolName: "Grep", parentCallId });

const ids = (rows: WorkerEventRow[]) => rows.map((r) => r.id);

describe("selectSubagentRows", () => {
  it("keeps a subagent's launch, inner tools and result; drops unrelated tool rows", () => {
    nextId = 1;
    const launch = agentCall("AG");
    const inner = innerStart("I1", "AG");
    const innerDone = toolResult("I1");
    const unrelated = toolCall("T1");
    const unrelatedDone = toolResult("T1");
    const result = toolResult("AG");
    const out = selectSubagentRows([launch, unrelated, inner, unrelatedDone, innerDone, result]);
    assert.deepEqual(ids(out), ids([launch, inner, innerDone, result]));
  });

  it("keeps parallel launches in one assistant message", () => {
    nextId = 1;
    const both = row("agent_event", { type: "message", role: "assistant", blocks: [
      { type: "tool_call", callId: "A", name: "Agent", spawnsSubagent: true },
      { type: "tool_call", callId: "B", name: "Agent", spawnsSubagent: true },
    ] });
    const doneB = toolResult("B");
    assert.deepEqual(ids(selectSubagentRows([both, doneB])), ids([both, doneB]));
  });

  it("keeps Artifact calls and their results", () => {
    nextId = 1;
    const publish = toolCall("AR", "Artifact");
    const other = toolCall("T1");
    const published = toolResult("AR");
    const legacy = row("tool_running", { toolName: "Artifact", toolUseId: "AR2", input: {} });
    const legacyDone = row("tool_done", { toolName: "Artifact", toolUseId: "AR2", result: "x" });
    const out = selectSubagentRows([publish, other, published, toolResult("T1"), legacy, legacyDone]);
    assert.deepEqual(ids(out), ids([publish, published, legacy, legacyDone]));
  });

  it("understands the legacy jsonl / tool_running / tool_done rows", () => {
    nextId = 1;
    const launch = row("jsonl", { kind: "tool_use", id: "AG", name: "Agent", input: {} });
    const inner = row("tool_running", { toolName: "Read", toolUseId: "I1", parentAgentToolUseId: "AG", input: {} });
    const other = row("tool_running", { toolName: "Bash", toolUseId: "T1", input: {} });
    const innerDone = row("tool_done", { toolName: "Read", toolUseId: "I1", result: "x" });
    const result = row("jsonl", { kind: "tool_result", toolUseId: "AG", text: "done" });
    assert.deepEqual(ids(selectSubagentRows([launch, inner, other, innerDone, result])), ids([launch, inner, innerDone, result]));
  });

  it("opens a pulse-only agent (hook window) and keeps its tool_done", () => {
    nextId = 1;
    const pulse = row("tool_running", { toolName: "Agent", toolUseId: "AG", input: {} });
    const done = row("tool_done", { toolName: "Agent", toolUseId: "AG", result: "r" });
    assert.deepEqual(ids(selectSubagentRows([pulse, done])), ids([pulse, done]));
  });

  it("keeps lifecycle rows, prompts/markers and turn barriers; drops other state/hook noise", () => {
    nextId = 1;
    const prompt = row("user_message", { text: "hi" });
    const started = row("agent_event", { type: "subagent_started", callId: "AG", agentId: "a1" });
    const completed = row("agent_event", { type: "subagent_completed", agentId: "a1", status: "completed" });
    const turnEnd = row("agent_event", { type: "turn", phase: "completed" });
    const turnStart = row("agent_event", { type: "turn", phase: "started" });
    const stop = row("hook", { event: "Stop" });
    const pre = row("hook", { event: "PreToolUse" });
    const idle = row("state", { state: "IDLE" });
    const working = row("state", { state: "WORKING" });
    const cleared = row("conversation_cleared", {});
    const text = row("agent_event", { type: "message", role: "assistant", blocks: [{ type: "text", text: "yo" }] });
    const out = selectSubagentRows([prompt, started, completed, turnStart, turnEnd, pre, stop, working, idle, text, cleared]);
    assert.deepEqual(ids(out), ids([prompt, started, completed, turnEnd, stop, idle, cleared]));
  });

  it("returns only the always-kept rows when no subagent ran", () => {
    nextId = 1;
    const prompt = row("user_message", { text: "hi" });
    const call = toolCall("T1");
    assert.deepEqual(ids(selectSubagentRows([prompt, call, toolResult("T1")])), ids([prompt]));
  });
});
