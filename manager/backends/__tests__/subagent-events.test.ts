// The in-process subagent attribution layer (childEmit's core). Mirrors the
// SdkEventMapper subagent-branch contract: a Task child's inner tools become
// PARENTED activity keyed to the Task tool_call id, its text/reasoning never reach
// the parent stream, and usage is forwarded so the child's tokens bill onto the parent.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mapSubagentEvent } from "../subagent-events.ts";
import type { AgentEvent } from "../../../contracts/src/canonical.ts";

const TASK = "task-call-1";

describe("mapSubagentEvent", () => {
  it("maps a child tool_call to a tool_started activity parented to the Task call", () => {
    const e: AgentEvent = { type: "message", role: "assistant", blocks: [{ type: "tool_call", callId: "inner-1", name: "Bash", input: { command: "ls" } }] };
    assert.deepEqual(mapSubagentEvent(TASK, e), [
      { type: "activity", kind: "tool_started", callId: "inner-1", toolName: "Bash", input: { command: "ls" }, parentCallId: TASK },
    ]);
  });

  it("maps a child tool_result to a tool_finished activity parented to the Task call", () => {
    const e: AgentEvent = { type: "message", role: "tool", blocks: [{ type: "tool_result", callId: "inner-1", isError: false, content: "out" }] };
    assert.deepEqual(mapSubagentEvent(TASK, e), [
      { type: "activity", kind: "tool_finished", callId: "inner-1", result: "out", isError: false, parentCallId: TASK },
    ]);
  });

  it("forwards usage verbatim (child tokens bill onto the parent)", () => {
    const usage: AgentEvent = { type: "usage", usage: { inputTokens: 3, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: {} } };
    assert.deepEqual(mapSubagentEvent(TASK, usage), [usage]);
  });

  it("drops child text, reasoning and skill blocks — they never reach the parent stream", () => {
    const text: AgentEvent = { type: "message", role: "assistant", blocks: [{ type: "text", text: "internal thought" }] };
    const reasoning: AgentEvent = { type: "message", role: "assistant", blocks: [{ type: "reasoning", text: "thinking" }] };
    const skill: AgentEvent = { type: "message", role: "assistant", blocks: [{ type: "skill", callId: "s1", text: "# body" }] };
    assert.deepEqual(mapSubagentEvent(TASK, text), []);
    assert.deepEqual(mapSubagentEvent(TASK, reasoning), []);
    assert.deepEqual(mapSubagentEvent(TASK, skill), []);
  });

  it("drops loop-internal turn / delta / context / session events", () => {
    const turn: AgentEvent = { type: "turn", phase: "ended" };
    const delta: AgentEvent = { type: "delta", channel: "text", phase: "append", blockId: "b", text: "x" };
    const context: AgentEvent = { type: "context", tokens: 42 };
    const session: AgentEvent = { type: "session", phase: "ready" };
    for (const e of [turn, delta, context, session]) assert.deepEqual(mapSubagentEvent(TASK, e), []);
  });

  it("splits a mixed assistant message: only tool_call blocks become activities, text is dropped", () => {
    const e: AgentEvent = {
      type: "message",
      role: "assistant",
      blocks: [
        { type: "text", text: "let me run this" },
        { type: "tool_call", callId: "inner-2", name: "Read", input: { file_path: "/x" } },
      ],
    };
    assert.deepEqual(mapSubagentEvent(TASK, e), [
      { type: "activity", kind: "tool_started", callId: "inner-2", toolName: "Read", input: { file_path: "/x" }, parentCallId: TASK },
    ]);
  });
});
