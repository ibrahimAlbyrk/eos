// subagent_profile: the model a subagent's own messages report and the effort
// its hooks carry, keyed to the spawning Agent call. The hook rides the control
// channel, so it may land before or after task_started maps agent_id → call.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AgentEvent } from "../../../../contracts/src/canonical.ts";
import { createSdkEventMapper, type SdkEventMapper } from "../SdkEventMapper.ts";

const AGENT_ID = "a7f3";
const CALL_ID = "toolu_spawn1";

const TASK_STARTED = { type: "system", subtype: "task_started", task_id: AGENT_ID, tool_use_id: CALL_ID, description: "Unity sürümü", subagent_type: "Explore" };
const subagentMsg = (model: string, content: unknown[] = [{ type: "tool_use", id: "toolu_in1", name: "Read", input: { file_path: "/x" } }]) =>
  ({ type: "assistant", parent_tool_use_id: CALL_ID, message: { id: "msg_sub", model, content } });

const profiles = (events: AgentEvent[]) => events.filter((e) => e.type === "subagent_profile");
const map = (m: SdkEventMapper, msg: unknown) => m.map(msg as never);

describe("SdkEventMapper — subagent_profile", () => {
  it("reports the model from the subagent's own message, once per change", () => {
    const m = createSdkEventMapper();
    assert.deepEqual(profiles(map(m, subagentMsg("claude-haiku-4-5"))), [{ type: "subagent_profile", callId: CALL_ID, model: "claude-haiku-4-5" }]);
    assert.deepEqual(profiles(map(m, subagentMsg("claude-haiku-4-5", []))), []);
  });

  it("reports the effort a hook inside the subagent carries, once task_started maps it", () => {
    const m = createSdkEventMapper();
    map(m, TASK_STARTED);
    map(m, subagentMsg("claude-sonnet-4-5"));
    assert.deepEqual(m.noteHook({ agent_id: AGENT_ID, effort: { level: "high" } }), [
      { type: "subagent_profile", callId: CALL_ID, model: "claude-sonnet-4-5", effort: "high" },
    ]);
    assert.deepEqual(m.noteHook({ agent_id: AGENT_ID, effort: { level: "high" } }), []);
  });

  it("holds an effort that beats task_started until the mapping lands", () => {
    const m = createSdkEventMapper();
    assert.deepEqual(m.noteHook({ agent_id: AGENT_ID, effort: { level: "xhigh" } }), []);
    assert.deepEqual(profiles(map(m, TASK_STARTED)), [{ type: "subagent_profile", callId: CALL_ID, effort: "xhigh" }]);
  });

  it("ignores main-thread hooks and models that take no effort", () => {
    const m = createSdkEventMapper();
    map(m, TASK_STARTED);
    assert.deepEqual(m.noteHook({ effort: { level: "high" } }), []);
    assert.deepEqual(m.noteHook({ agent_id: AGENT_ID }), []);
  });

  it("never emits a profile for top-level messages", () => {
    const m = createSdkEventMapper();
    const top = { type: "assistant", message: { id: "msg_top", model: "claude-opus-4-5", content: [{ type: "text", text: "hi" }] } };
    assert.deepEqual(profiles(map(m, top)), []);
  });
});
