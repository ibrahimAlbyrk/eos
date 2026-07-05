// Live message ordering: the SDK emits system/task_started BEFORE the
// async_launched stub tool_result (observed on claude-agent-sdk 0.3.x streams;
// sdk-subagent-events.test.ts fixtures never carry task_started, so this file
// covers the ordering that suppressed subagent_started in production).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AgentEvent } from "../../../../contracts/src/canonical.ts";
import { createSdkEventMapper, type SdkEventMapper } from "../SdkEventMapper.ts";

const AGENT_ID = "a5ac401ef524c899c";
const CALL_ID = "toolu_spawnLive1";
const OUTPUT_FILE = "/tmp/claude-501/proj/sess/tasks/a5ac401ef524c899c.output";

const SPAWN = {
  type: "assistant",
  uuid: "u1",
  message: { id: "msg_A", content: [{ type: "tool_use", id: CALL_ID, name: "Agent", input: { prompt: "find X", run_in_background: true } }] },
};

// SDKTaskStartedMessage — fires the moment the task registers, ahead of the stub.
const TASK_STARTED = {
  type: "system",
  subtype: "task_started",
  task_id: AGENT_ID,
  tool_use_id: CALL_ID,
  description: "Find X",
  subagent_type: "Explore",
  task_type: "local_agent",
};

const STUB_TEXT = `Async agent launched successfully.\nagentId: ${AGENT_ID} (internal ID - do not mention to user.)\noutput_file: ${OUTPUT_FILE}`;

const STUB_RESULT = {
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: CALL_ID, content: [{ type: "text", text: STUB_TEXT }] }] },
  tool_use_result: { isAsync: true, status: "async_launched", agentId: AGENT_ID, description: "Find X", outputFile: OUTPUT_FILE },
};

const NOTIFICATION = {
  type: "system",
  subtype: "task_notification",
  task_id: AGENT_ID,
  tool_use_id: CALL_ID,
  status: "completed",
  output_file: OUTPUT_FILE,
  summary: 'Agent "Find X" finished',
  usage: { total_tokens: 500, tool_uses: 3, duration_ms: 4000 },
};

const CARRIER = {
  type: "user",
  message: { content: `<task-notification>\n<task-id>${AGENT_ID}</task-id>\n<tool-use-id>${CALL_ID}</tool-use-id>\n<output-file>${OUTPUT_FILE}</output-file>\n<status>completed</status>\n<summary>Agent "Find X" finished</summary>\n<result>Full final report.</result>\n</task-notification>` },
};

function run(mapper: SdkEventMapper, msgs: unknown[]): AgentEvent[] {
  const out: AgentEvent[] = [];
  for (const m of msgs) out.push(...mapper.map(m as never));
  return out;
}

function subagentEvents(events: AgentEvent[]): AgentEvent[] {
  return events.filter((e) => e.type === "subagent_started" || e.type === "subagent_completed");
}

describe("SdkEventMapper — live ordering (task_started precedes the stub)", () => {
  it("emits exactly one subagent_started when task_started pre-creates the entry", () => {
    const mapper = createSdkEventMapper();
    const out = subagentEvents(run(mapper, [SPAWN, TASK_STARTED, STUB_RESULT, NOTIFICATION, CARRIER]));
    const started = out.filter((e) => e.type === "subagent_started");
    assert.deepEqual(started, [
      { type: "subagent_started", callId: CALL_ID, agentId: AGENT_ID, background: true, description: "Find X", outputFile: OUTPUT_FILE },
    ]);
    const completed = out.filter((e) => e.type === "subagent_completed");
    assert.ok(completed.length >= 1, "completion still reported");
    const last = completed[completed.length - 1] as { status?: string; result?: string; callId?: string | null };
    assert.equal(last.status, "completed");
    assert.equal(last.callId, CALL_ID);
    assert.equal(last.result, "Full final report.", "latest completion carries the carrier's full <result>");
  });

  it("emits started before completed, once each, when the carrier never arrives", () => {
    const mapper = createSdkEventMapper();
    const out = subagentEvents(run(mapper, [SPAWN, TASK_STARTED, STUB_RESULT, NOTIFICATION]));
    assert.deepEqual(out.map((e) => e.type), ["subagent_started", "subagent_completed"]);
  });

  it("stays silent for a foreground subagent even though task_started fires for it", () => {
    const mapper = createSdkEventMapper();
    const fgStarted = { ...TASK_STARTED, task_id: "afg42", subagent_type: "general-purpose" };
    const fgResult = {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: CALL_ID, content: [{ type: "text", text: "final answer" }] }] },
      tool_use_result: { agentId: "afg42", content: [{ type: "text", text: "final answer" }], status: "completed", prompt: "p", totalToolUseCount: 2, totalDurationMs: 100, totalTokens: 50 },
    };
    assert.deepEqual(subagentEvents(run(mapper, [SPAWN, fgStarted, fgResult])), []);
  });
});
