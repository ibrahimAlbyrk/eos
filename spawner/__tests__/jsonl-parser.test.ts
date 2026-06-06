import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseJsonlLine } from "../jsonl-parser.ts";

type Event = { type: string; payload: unknown };
const collect = (line: string, model = "opus"): Event[] => {
  const out: Event[] = [];
  parseJsonlLine(line, (type, payload) => out.push({ type, payload }), model);
  return out;
};

describe("parseJsonlLine — malformed input", () => {
  it("ignores invalid JSON silently", () => {
    assert.deepEqual(collect("not json"), []);
  });
  it("ignores unrelated message shapes", () => {
    assert.deepEqual(collect(JSON.stringify({ type: "something_else" })), []);
  });
  it("ignores empty content arrays", () => {
    assert.deepEqual(collect(JSON.stringify({ message: { role: "assistant", content: [] } })), []);
  });
});

describe("parseJsonlLine — assistant messages", () => {
  it("extracts assistant text block", () => {
    const ev = collect(JSON.stringify({
      message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
    }));
    assert.equal(ev.length, 1);
    assert.equal(ev[0].type, "jsonl");
    assert.equal((ev[0].payload as { kind: string; text: string }).kind, "assistant_text");
    assert.equal((ev[0].payload as { text: string }).text, "hello");
  });

  it("extracts tool_use block with id", () => {
    const ev = collect(JSON.stringify({
      message: { role: "assistant", content: [
        { type: "tool_use", id: "T1", name: "Read", input: { path: "/x" } },
      ]},
    }));
    assert.equal(ev.length, 1);
    const p = ev[0].payload as { kind: string; id: string; name: string; input: { path: string } };
    assert.equal(p.kind, "tool_use");
    assert.equal(p.id, "T1");
    assert.equal(p.name, "Read");
    assert.equal(p.input.path, "/x");
  });

  it("extracts thinking block (prefers .thinking over .text)", () => {
    const ev = collect(JSON.stringify({
      message: { role: "assistant", content: [
        { type: "thinking", thinking: "deliberating", text: "fallback" },
      ]},
    }));
    assert.equal(ev.length, 1);
    assert.equal((ev[0].payload as { text: string }).text, "deliberating");
  });

  it("skips signature-only thinking blocks (empty thinking text)", () => {
    const ev = collect(JSON.stringify({
      message: { role: "assistant", content: [
        { type: "thinking", thinking: "", signature: "EtoCCmMIDRgC" },
      ]},
    }));
    assert.equal(ev.length, 0);
  });

  it("extracts text + tool_use + thinking from a single message in order", () => {
    const ev = collect(JSON.stringify({
      message: { role: "assistant", content: [
        { type: "thinking", thinking: "first" },
        { type: "text", text: "second" },
        { type: "tool_use", id: "T1", name: "Read", input: {} },
      ]},
    }));
    assert.deepEqual(ev.map(e => (e.payload as { kind: string }).kind), ["thinking", "assistant_text", "tool_use"]);
  });

  it("emits usage event when message carries token counts", () => {
    const ev = collect(JSON.stringify({
      message: {
        role: "assistant",
        model: "claude-sonnet-4.5",
        content: [],
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 },
      },
    }));
    assert.equal(ev.length, 1);
    assert.equal(ev[0].type, "usage");
    const p = ev[0].payload as { in: number; out: number; cacheRead: number; cacheCreate: number; model: string };
    assert.equal(p.in, 100);
    assert.equal(p.out, 50);
    assert.equal(p.cacheRead, 10);
    assert.equal(p.cacheCreate, 5);
    assert.equal(p.model, "claude-sonnet-4.5");
  });

  it("splits cache creation tokens by TTL when usage.cache_creation present", () => {
    const ev = collect(JSON.stringify({
      message: {
        role: "assistant",
        model: "claude-sonnet-4.5",
        content: [],
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 5000,
          cache_creation: { ephemeral_5m_input_tokens: 3000, ephemeral_1h_input_tokens: 2000 },
        },
      },
    }));
    const p = ev[0].payload as { cacheCreate: number; cacheCreate1h: number };
    assert.equal(p.cacheCreate, 3000);
    assert.equal(p.cacheCreate1h, 2000);
  });

  it("treats cache_creation_input_tokens as 5m when split object absent", () => {
    const ev = collect(JSON.stringify({
      message: {
        role: "assistant",
        model: "claude-opus-4.7",
        content: [],
        usage: { input_tokens: 10, cache_creation_input_tokens: 500 },
      },
    }));
    const p = ev[0].payload as { cacheCreate: number; cacheCreate1h: number };
    assert.equal(p.cacheCreate, 500);
    assert.equal(p.cacheCreate1h, 0);
  });

  it("usage falls back to defaultModel when message lacks model", () => {
    const ev = collect(JSON.stringify({
      message: { role: "assistant", content: [], usage: { input_tokens: 1 } },
    }), "haiku");
    assert.equal((ev[0].payload as { model: string }).model, "haiku");
  });
});

describe("parseJsonlLine — user messages", () => {
  it("extracts tool_result with string content", () => {
    const ev = collect(JSON.stringify({
      message: { role: "user", content: [
        { type: "tool_result", tool_use_id: "T1", content: "file contents", is_error: false },
      ]},
    }));
    assert.equal(ev.length, 1);
    const p = ev[0].payload as { kind: string; toolUseId: string; text: string; isError: boolean };
    assert.equal(p.kind, "tool_result");
    assert.equal(p.toolUseId, "T1");
    assert.equal(p.text, "file contents");
    assert.equal(p.isError, false);
  });

  it("extracts tool_result with array content", () => {
    const ev = collect(JSON.stringify({
      message: { role: "user", content: [
        { type: "tool_result", tool_use_id: "T2", content: [{ text: "part1" }, { text: "part2" }] },
      ]},
    }));
    assert.equal((ev[0].payload as { text: string }).text, "part1part2");
  });

  it("flags errors via is_error", () => {
    const ev = collect(JSON.stringify({
      message: { role: "user", content: [
        { type: "tool_result", tool_use_id: "T3", content: "boom", is_error: true },
      ]},
    }));
    assert.equal((ev[0].payload as { isError: boolean }).isError, true);
  });
});

describe("parseJsonlLine — attachment + legacy", () => {
  it("synthesizes tool_result from hook_success attachment", () => {
    const ev = collect(JSON.stringify({
      type: "attachment",
      attachment: { type: "hook_success", toolUseID: "T9", content: "ok", exitCode: 0 },
    }));
    assert.equal(ev.length, 1);
    const p = ev[0].payload as { kind: string; toolUseId: string; isError: boolean };
    assert.equal(p.kind, "tool_result");
    assert.equal(p.toolUseId, "T9");
    assert.equal(p.isError, false);
  });

  it("marks attachment as error when exitCode >= 400", () => {
    const ev = collect(JSON.stringify({
      type: "attachment",
      attachment: { type: "hook_success", toolUseID: "T9", stdout: "fail", exitCode: 500 },
    }));
    assert.equal((ev[0].payload as { isError: boolean }).isError, true);
  });

  it("drops empty PostToolUse hook ack so it does not duplicate the real tool_result", () => {
    const ev = collect(JSON.stringify({
      type: "attachment",
      attachment: {
        type: "hook_success",
        hookName: "PostToolUse:Read",
        toolUseID: "T9",
        hookEvent: "PostToolUse",
        content: "",
        stdout: '{"continue":true}',
        stderr: "",
        exitCode: 200,
      },
    }));
    assert.deepEqual(ev, []);
  });

  it("emits when hook failed even if content is empty (falls back to stdout)", () => {
    const ev = collect(JSON.stringify({
      type: "attachment",
      attachment: { type: "hook_success", toolUseID: "T9", content: "", stdout: "hook crash", exitCode: 500 },
    }));
    assert.equal(ev.length, 1);
    const p = ev[0].payload as { isError: boolean; text: string };
    assert.equal(p.isError, true);
    assert.equal(p.text, "hook crash");
  });

  it("prefers content over stdout when both are present (success path)", () => {
    const ev = collect(JSON.stringify({
      type: "attachment",
      attachment: { type: "hook_success", toolUseID: "T9", content: "real result", stdout: '{"continue":true}', exitCode: 0 },
    }));
    assert.equal(ev.length, 1);
    assert.equal((ev[0].payload as { text: string }).text, "real result");
  });

  it("handles legacy top-level tool_use", () => {
    const ev = collect(JSON.stringify({ type: "tool_use", name: "Read", input: { path: "/x" } }));
    assert.equal(ev.length, 1);
    assert.equal((ev[0].payload as { kind: string; name: string }).name, "Read");
  });

  it("handles legacy top-level tool_result", () => {
    const ev = collect(JSON.stringify({ type: "tool_result", content: [{ text: "hi" }], isError: false }));
    assert.equal(ev.length, 1);
    assert.equal((ev[0].payload as { text: string }).text, "hi");
  });
});

describe("parseJsonlLine — non-array msg.content", () => {
  it("string content → emits nothing, no crash", () => {
    const ev = collect(JSON.stringify({
      message: { role: "assistant", content: "just a string" },
    }));
    assert.deepEqual(ev, []);
  });

  it("null content → emits nothing, no crash", () => {
    const ev = collect(JSON.stringify({
      message: { role: "assistant", content: null },
    }));
    assert.deepEqual(ev, []);
  });

  it("undefined content → emits nothing, no crash", () => {
    const ev = collect(JSON.stringify({
      message: { role: "assistant" },
    }));
    assert.deepEqual(ev, []);
  });

  it("number content → emits nothing, no crash", () => {
    const ev = collect(JSON.stringify({
      message: { role: "assistant", content: 42 },
    }));
    assert.deepEqual(ev, []);
  });

  it("string content on user role → emits nothing, no crash", () => {
    const ev = collect(JSON.stringify({
      message: { role: "user", content: "just a string" },
    }));
    assert.deepEqual(ev, []);
  });

  it("null content on user role → emits nothing, no crash", () => {
    const ev = collect(JSON.stringify({
      message: { role: "user", content: null },
    }));
    assert.deepEqual(ev, []);
  });
});
