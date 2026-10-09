// A present call's input streams as genui:delta while the model writes it — and
// nothing else changes: reasoning/text deltas, the durable tool_call and every
// other tool's input_json_delta map exactly as before.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSdkEventMapper, type GenuiInputDelta } from "../SdkEventMapper.ts";

type Msg = Parameters<ReturnType<typeof createSdkEventMapper>["map"]>[0];

const ev = (event: Record<string, unknown>): Msg => ({ type: "stream_event", event } as unknown as Msg);
const start = (index: number, id: string, name: string): Msg =>
  ev({ type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } });
const json = (index: number, partial_json: string): Msg =>
  ev({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json } });
const stop = (index: number): Msg => ev({ type: "content_block_stop", index });

function harness(clock = { t: 0 }) {
  const seen: GenuiInputDelta[] = [];
  const events: unknown[] = [];
  const mapper = createSdkEventMapper({ onGenuiDelta: (d) => seen.push(d), now: () => clock.t });
  const feed = (...msgs: Msg[]): void => { for (const m of msgs) events.push(...mapper.map(m)); };
  return { seen, events, feed, clock, mapper };
}

describe("SdkEventMapper — genui:delta for present calls", () => {
  it("streams a present call's input: start, merged appends, stop", () => {
    const h = harness();
    h.feed(ev({ type: "message_start", message: { id: "msg_A" } }), start(0, "toolu_1", "mcp__orchestrator__present"));
    h.feed(json(0, '{"title":'));
    h.clock.t = 10;
    h.feed(json(0, '"Kad'), json(0, 'ıköy"'));
    h.clock.t = 100;
    h.feed(json(0, ',"ui":"<Map'), stop(0));
    const name = "mcp__orchestrator__present";
    assert.deepEqual(h.seen, [
      { callId: "toolu_1", name, phase: "start", text: "" },
      { callId: "toolu_1", name, phase: "append", text: '{"title":' },
      { callId: "toolu_1", name, phase: "append", text: '"Kadıköy","ui":"<Map' },
      { callId: "toolu_1", name, phase: "stop", text: "" },
    ]);
    assert.equal(h.seen.filter((d) => d.phase !== "stop").map((d) => d.text).join(""), '{"title":"Kadıköy","ui":"<Map');
  });

  it("covers present_app under either server, and nothing for other tools", () => {
    const h = harness();
    h.feed(ev({ type: "message_start", message: { id: "msg_B" } }));
    h.feed(start(0, "t_app", "mcp__worker__present_app"), json(0, '{"html":"<p>'), stop(0));
    h.feed(start(1, "t_other", "mcp__orchestrator__spawn_worker"), json(1, '{"prompt":"x"}'), stop(1));
    h.feed(start(2, "t_bash", "Bash"), json(2, '{"command":"ls"}'), stop(2));
    h.feed(start(3, "t_lookalike", "mcp__orchestrator__presentation"), json(3, "{}"), stop(3));
    h.feed(start(4, "t_user_server", "mcp__slides__present"), json(4, "{}"), stop(4));
    assert.deepEqual(h.seen.map((d) => `${d.callId}:${d.phase}`), ["t_app:start", "t_app:append", "t_app:stop"]);
  });

  it("leaves agent deltas and the durable message untouched", () => {
    const withGenui = harness();
    const without = createSdkEventMapper();
    const msgs: Msg[] = [
      ev({ type: "message_start", message: { id: "msg_C" } }),
      ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Here you go" } }),
      stop(0),
      start(1, "toolu_9", "mcp__worker__present"),
      json(1, '{"title":"x","ui":"<Text>hi</Text>","summary":"hi"}'),
      stop(1),
      { type: "assistant", message: { id: "msg_C", content: [
        { type: "text", text: "Here you go" },
        { type: "tool_use", id: "toolu_9", name: "mcp__worker__present", input: { title: "x", ui: "<Text>hi</Text>", summary: "hi" } },
      ] } } as Msg,
      { type: "result", subtype: "success", usage: {} } as Msg,
    ];
    withGenui.feed(...msgs);
    const plain = msgs.flatMap((m) => without.map(m));
    assert.deepEqual(withGenui.events, plain, "the AgentEvents are identical with or without the genui sink");
    const deltas = plain.filter((e) => (e as { type: string }).type === "delta");
    assert.ok(deltas.every((d) => (d as { channel: string }).channel === "text"));
    assert.ok(!JSON.stringify(deltas).includes("title"), "no tool JSON on the agent delta channel");
    const message = plain.find((e) => (e as { type: string }).type === "message") as { blocks: Array<{ type: string; callId?: string }> };
    assert.deepEqual(message.blocks.map((b) => b.type), ["text", "tool_call"]);
    assert.equal(message.blocks[1]!.callId, "toolu_9");
    assert.equal(withGenui.seen.at(-1)?.phase, "stop");
  });

  it("closes a stream the turn cut off (interrupt) so no preview hangs", () => {
    const h = harness();
    h.feed(ev({ type: "message_start", message: { id: "msg_D" } }), start(0, "toolu_2", "mcp__orchestrator__present"), json(0, '{"ti'));
    h.feed({ type: "result", subtype: "error_during_execution", usage: {} } as Msg);
    assert.deepEqual(h.seen.map((d) => d.phase), ["start", "append", "stop"]);
  });

  it("the durable assistant block closes a stream whose stop never came", () => {
    const h = harness();
    h.feed(ev({ type: "message_start", message: { id: "msg_E" } }), start(0, "toolu_3", "mcp__orchestrator__present"));
    h.clock.t = 5;
    h.feed(json(0, '{"a":'), json(0, "1}"));
    h.feed({ type: "assistant", message: { id: "msg_E", content: [{ type: "tool_use", id: "toolu_3", name: "mcp__orchestrator__present", input: { a: 1 } }] } } as Msg);
    assert.deepEqual(h.seen.map((d) => [d.phase, d.text]), [["start", ""], ["append", '{"a":'], ["append", "1}"], ["stop", ""]]);
  });

  it("ignores subagent-internal streams and works without a sink", () => {
    const h = harness();
    h.feed({ type: "stream_event", parent_tool_use_id: "agent_1", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "x", name: "mcp__worker__present" } } } as Msg);
    assert.deepEqual(h.seen, []);
    const bare = createSdkEventMapper();
    assert.doesNotThrow(() => { bare.map(start(0, "y", "mcp__orchestrator__present")); bare.map(json(0, "{")); bare.map(stop(0)); });
  });

  it("a throwing sink never breaks the mapping", () => {
    const mapper = createSdkEventMapper({ onGenuiDelta: () => { throw new Error("bus down"); } });
    mapper.map(ev({ type: "message_start", message: { id: "msg_F" } }));
    assert.doesNotThrow(() => mapper.map(start(0, "z", "mcp__orchestrator__present")));
  });
});
