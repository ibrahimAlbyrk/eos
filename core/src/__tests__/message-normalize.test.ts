import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeEventRows } from "../domain/message-normalize.ts";
import type { WorkerEventRow } from "../../../contracts/src/events.ts";

let seq = 0;
function row(type: string, payload: unknown, ts = ++seq): WorkerEventRow {
  return { id: seq, worker_id: "w-1", ts, type, payload: payload === null ? null : JSON.stringify(payload) };
}

describe("normalizeEventRows", () => {
  it("maps an agent_event assistant message to joined text blocks", () => {
    const rows = [
      row("agent_event", {
        type: "message",
        role: "assistant",
        blocks: [
          { type: "text", text: "first" },
          { type: "reasoning", text: "hidden thinking" },
          { type: "text", text: "second" },
        ],
      }, 100),
    ];
    assert.deepEqual(normalizeEventRows(rows, 5), [{ ts: 100, role: "assistant", text: "first\nsecond" }]);
  });

  it("maps a jsonl assistant_text to an assistant message", () => {
    const rows = [row("jsonl", { kind: "assistant_text", text: "cli reply" }, 200)];
    assert.deepEqual(normalizeEventRows(rows, 5), [{ ts: 200, role: "assistant", text: "cli reply" }]);
  });

  it("maps every inbound message type to its role", () => {
    const rows = [
      row("user_message", { text: "hello" }),
      row("orchestrator_message", { text: "do X", fromParent: "o-1", parentName: "Orch" }),
      row("worker_report", { text: "result: done", fromWorker: "w-2", workerName: "child" }),
      row("peer_request", { text: "any tips?", fromWorker: "p-9" }),
    ];
    assert.deepEqual(
      normalizeEventRows(rows, 5).map((m) => m.role),
      ["user", "orchestrator", "worker", "peer"],
    );
  });

  it("skips tool_use / thinking (jsonl) and tool/reasoning-only (agent_event) rows", () => {
    const rows = [
      row("jsonl", { kind: "thinking", text: "hmm" }),
      row("jsonl", { kind: "tool_use", name: "Bash", input: {} }),
      row("jsonl", { kind: "tool_result", isError: false, text: "ok" }),
      row("agent_event", { type: "message", role: "assistant", blocks: [{ type: "tool_call", callId: "c1", name: "Bash", input: {} }] }),
      row("agent_event", { type: "message", role: "assistant", blocks: [{ type: "reasoning", text: "just thinking" }] }),
      row("agent_event", { type: "message", role: "tool", blocks: [{ type: "tool_result", callId: "c1", content: "done" }] }),
      row("agent_event", { type: "turn", phase: "ended" }),
      row("usage", { in: 10, out: 20 }),
    ];
    assert.deepEqual(normalizeEventRows(rows, 5), []);
  });

  it("skips legacy jsonl user_text / skill_body (the daemon covers inbound turns)", () => {
    const rows = [
      row("jsonl", { kind: "user_text", text: "duplicate user turn" }),
      row("jsonl", { kind: "skill_body", toolUseId: "t1", text: "SKILL.md body" }),
    ];
    assert.deepEqual(normalizeEventRows(rows, 5), []);
  });

  it("returns the newest n messages in oldest->newest order", () => {
    const rows = [
      row("user_message", { text: "m1" }),
      row("agent_event", { type: "message", role: "assistant", blocks: [{ type: "text", text: "m2" }] }),
      row("tool_running", { toolName: "Bash", toolUseId: null, input: {} }), // non-message noise between
      row("user_message", { text: "m3" }),
      row("jsonl", { kind: "assistant_text", text: "m4" }),
    ];
    assert.deepEqual(
      normalizeEventRows(rows, 2).map((m) => m.text),
      ["m3", "m4"],
    );
  });

  it("returns everything when fewer than n messages exist", () => {
    const rows = [row("user_message", { text: "only one" })];
    const out = normalizeEventRows(rows, 5);
    assert.equal(out.length, 1);
    assert.equal(out[0].text, "only one");
  });

  it("returns [] for empty input, non-positive n, and unparseable payloads", () => {
    assert.deepEqual(normalizeEventRows([], 5), []);
    assert.deepEqual(normalizeEventRows([row("user_message", { text: "x" })], 0), []);
    assert.deepEqual(normalizeEventRows([row("user_message", null), row("agent_event", null)], 5), []);
  });
});
