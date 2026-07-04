// Background-subagent lifecycle mapping: async_launched stub -> subagent_started,
// task_notification / injected <task-notification> user-turn carrier ->
// subagent_completed. Fixture shapes are byte-exact copies of the runtime
// carriers observed from claude-agent-sdk 0.3.195 (see SdkEventMapper.ts).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AgentEvent } from "../../../../contracts/src/canonical.ts";
import { createSdkEventMapper, type SdkEventMapper } from "../SdkEventMapper.ts";

const AGENT_ID = "a54f36a2b9d23fe36";
const CALL_ID = "toolu_spawn1";
const OUTPUT_FILE = "/tmp/claude-501/proj/sess/tasks/a54f36a2b9d23fe36.output";

const SPAWN = {
  type: "assistant",
  uuid: "u1",
  message: { id: "msg_A", content: [{ type: "tool_use", id: CALL_ID, name: "Agent", input: { prompt: "research X", run_in_background: true } }] },
};

const STUB_TEXT = `Async agent launched successfully.\nagentId: ${AGENT_ID} (internal ID - do not mention to user.)\nThe agent is working in the background. You will be notified automatically when it completes.\noutput_file: ${OUTPUT_FILE}\nDo NOT Read or tail this file via the shell tool.`;

const STUB_RESULT = {
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: CALL_ID, content: [{ type: "text", text: STUB_TEXT }] }] },
  tool_use_result: { isAsync: true, status: "async_launched", agentId: AGENT_ID, description: "Research X", resolvedModel: "claude-opus-4-8", prompt: "research X", outputFile: OUTPUT_FILE, canReadOutputFile: true },
};

const NOTIFICATION = {
  type: "system",
  subtype: "task_notification",
  task_id: AGENT_ID,
  tool_use_id: CALL_ID,
  status: "completed",
  output_file: OUTPUT_FILE,
  summary: 'Agent "Research X" finished',
  usage: { total_tokens: 1234, tool_uses: 7, duration_ms: 9000 },
};

const CARRIER_TEXT = `<task-notification>\n<task-id>${AGENT_ID}</task-id>\n<tool-use-id>${CALL_ID}</tool-use-id>\n<output-file>${OUTPUT_FILE}</output-file>\n<status>completed</status>\n<summary>Agent "Research X" finished</summary>\n<note>A task-notification fires each time this agent stops.</note>\n<result>Full final report text.\n\nWith multiple lines.</result>\n</task-notification>`;

const CARRIER = { type: "user", message: { content: CARRIER_TEXT } };

function run(mapper: SdkEventMapper, msgs: unknown[]): AgentEvent[] {
  const out: AgentEvent[] = [];
  for (const m of msgs) out.push(...mapper.map(m as never));
  return out;
}

function subagentEvents(events: AgentEvent[]): AgentEvent[] {
  return events.filter((e) => e.type === "subagent_started" || e.type === "subagent_completed");
}

describe("SdkEventMapper — background subagent events", () => {
  it("maps the async_launched stub (structured sidecar) to subagent_started, keeping the tool_result block", () => {
    const mapper = createSdkEventMapper();
    const out = run(mapper, [SPAWN, STUB_RESULT]);
    assert.ok(out.some((e) => e.type === "message" && e.role === "tool"), "existing tool_result path unchanged");
    assert.deepEqual(subagentEvents(out), [
      { type: "subagent_started", callId: CALL_ID, agentId: AGENT_ID, background: true, description: "Research X", outputFile: OUTPUT_FILE },
    ]);
  });

  it("falls back to stub-text parse when no sidecar rides the message (gated on a known Agent call)", () => {
    const mapper = createSdkEventMapper();
    const stubNoSidecar = { ...STUB_RESULT, tool_use_result: undefined };
    const out = subagentEvents(run(mapper, [SPAWN, stubNoSidecar]));
    assert.deepEqual(out, [
      { type: "subagent_started", callId: CALL_ID, agentId: AGENT_ID, background: true, outputFile: OUTPUT_FILE },
    ]);
    // Same stub text on an UNKNOWN callId (no Agent tool_use seen) emits nothing.
    const strangerMapper = createSdkEventMapper();
    assert.deepEqual(subagentEvents(run(strangerMapper, [stubNoSidecar])), []);
  });

  it("maps task_notification with tool_use_id to subagent_completed (summary result, mapped usage)", () => {
    const mapper = createSdkEventMapper();
    const out = subagentEvents(run(mapper, [SPAWN, STUB_RESULT, NOTIFICATION])).slice(1);
    assert.deepEqual(out, [
      {
        type: "subagent_completed",
        agentId: AGENT_ID,
        callId: CALL_ID,
        status: "completed",
        result: 'Agent "Research X" finished',
        outputFile: OUTPUT_FILE,
        usage: { totalTokens: 1234, toolUses: 7, durationMs: 9000 },
      },
    ]);
  });

  it("resolves callId via the agentId map when task_notification omits tool_use_id", () => {
    const mapper = createSdkEventMapper();
    const noToolUseId = { ...NOTIFICATION, tool_use_id: undefined, status: "failed" };
    const out = subagentEvents(run(mapper, [SPAWN, STUB_RESULT, noToolUseId])).slice(1);
    assert.equal(out.length, 1);
    assert.equal(out[0].type, "subagent_completed");
    assert.equal((out[0] as { callId?: string | null }).callId, CALL_ID);
    assert.equal((out[0] as { status?: string }).status, "failed");
  });

  it("upgrades a summary-only completion with the carrier's full <result>", () => {
    const mapper = createSdkEventMapper();
    run(mapper, [SPAWN, STUB_RESULT, NOTIFICATION]);
    const out = subagentEvents(run(mapper, [CARRIER]));
    assert.deepEqual(out, [
      {
        type: "subagent_completed",
        agentId: AGENT_ID,
        callId: CALL_ID,
        status: "completed",
        result: "Full final report text.\n\nWith multiple lines.",
        outputFile: OUTPUT_FILE,
        usage: { totalTokens: 1234, toolUses: 7, durationMs: 9000 },
      },
    ]);
  });

  it("drops a summary-only carrier when the system notification already reported that stop", () => {
    const mapper = createSdkEventMapper();
    run(mapper, [SPAWN, STUB_RESULT, NOTIFICATION]);
    const resultless = { type: "user", message: { content: CARRIER_TEXT.replace(/<result>[\s\S]*<\/result>\n/, "") } };
    assert.deepEqual(subagentEvents(run(mapper, [resultless])), []);
  });

  it("reports completion from the carrier alone when no system notification arrived", () => {
    const mapper = createSdkEventMapper();
    run(mapper, [SPAWN, STUB_RESULT]);
    const out = subagentEvents(run(mapper, [CARRIER]));
    assert.equal(out.length, 1);
    assert.equal(out[0].type, "subagent_completed");
    assert.equal((out[0] as { result?: string }).result, "Full final report text.\n\nWith multiple lines.");
  });

  it("emits NO subagent events for a foreground Agent run", () => {
    const mapper = createSdkEventMapper();
    const foreground = {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: CALL_ID, content: [{ type: "text", text: "final answer" }] }] },
      tool_use_result: { agentId: "afg1", content: [{ type: "text", text: "final answer" }], status: "completed", prompt: "p", totalToolUseCount: 2, totalDurationMs: 100, totalTokens: 50, usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: null, cache_creation: null } },
    };
    assert.deepEqual(subagentEvents(run(mapper, [SPAWN, foreground])), []);
  });

  it("ignores task carriers of non-subagent background tasks (Bash/Monitor/workflows)", () => {
    const mapper = createSdkEventMapper();
    const bashNotification = { ...NOTIFICATION, task_id: "bssnhs4ej", tool_use_id: "toolu_bash1" };
    const bashCarrier = { type: "user", message: { content: "<task-notification>\n<task-id>bssnhs4ej</task-id>\n<status>completed</status>\n<summary>Background command finished</summary>\n</task-notification>" } };
    assert.deepEqual(subagentEvents(run(mapper, [SPAWN, STUB_RESULT, bashNotification, bashCarrier])).slice(1), []);
  });
});
