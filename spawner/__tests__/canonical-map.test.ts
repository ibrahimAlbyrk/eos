import { test } from "node:test";
import assert from "node:assert/strict";

import { toCanonicalEvents } from "../canonical-map.ts";
import { AgentEventSchema } from "../../contracts/src/canonical.ts";

// Every event the translator produces MUST validate against the canonical
// contract — this ties the claude-cli adapter to the schema.
function mapValid(type: string, payload: unknown) {
  const out = toCanonicalEvents(type, payload);
  for (const e of out) AgentEventSchema.parse(e);
  return out;
}

test("jsonl assistant_text → message{text}", () => {
  const out = mapValid("jsonl", { kind: "assistant_text", text: "hello" });
  assert.deepEqual(out, [{ type: "message", role: "assistant", blocks: [{ type: "text", text: "hello" }] }]);
});

test("jsonl thinking → message{reasoning}", () => {
  const out = mapValid("jsonl", { kind: "thinking", text: "hmm" });
  assert.equal(out[0].type, "message");
  assert.deepEqual(out[0].blocks, [{ type: "reasoning", text: "hmm" }]);
});

test("jsonl tool_use → message{tool_call} carrying id/name/input", () => {
  const out = mapValid("jsonl", { kind: "tool_use", id: "toolu_1", name: "Bash", input: { cmd: "ls" } });
  assert.deepEqual(out[0].blocks, [{ type: "tool_call", callId: "toolu_1", name: "Bash", input: { cmd: "ls" } }]);
});

test("jsonl tool_use without input defaults to {}", () => {
  const out = mapValid("jsonl", { kind: "tool_use", id: "t", name: "Read" });
  assert.deepEqual(out[0].blocks[0].input, {});
});

test("jsonl tool_result → message{role:tool, tool_result}", () => {
  const out = mapValid("jsonl", { kind: "tool_result", toolUseId: "toolu_1", isError: true, text: "boom" });
  assert.equal(out[0].role, "tool");
  assert.deepEqual(out[0].blocks, [{ type: "tool_result", callId: "toolu_1", isError: true, content: "boom" }]);
});

test("jsonl skill_body → message{skill} correlated by callId", () => {
  const out = mapValid("jsonl", { kind: "skill_body", toolUseId: "toolu_9", text: "/skills/x\nbody" });
  assert.equal(out[0].role, "assistant");
  assert.deepEqual(out[0].blocks, [{ type: "skill", callId: "toolu_9", text: "/skills/x\nbody" }]);
});

test("usage → usage event with split cache tiers, zeros omitted", () => {
  const out = mapValid("usage", { in: 100, out: 50, cacheRead: 10, cacheCreate: 5, cacheCreate1h: 0, model: "opus" });
  assert.deepEqual(out, [{
    type: "usage",
    usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: { "5m": 5 }, model: "opus" },
  }]);
});

test("usage with both cache tiers keeps both keys", () => {
  const out = mapValid("usage", { in: 1, out: 1, cacheRead: 0, cacheCreate: 2, cacheCreate1h: 3, model: "sonnet" });
  assert.deepEqual(out[0].usage.cacheWriteTokens, { "5m": 2, "1h": 3 });
});

test("hook PreToolUse/PostToolUse → activity tool_started/finished", () => {
  const pre = mapValid("hook", { event: "PreToolUse", body: { tool_name: "Edit", tool_use_id: "x" } });
  assert.deepEqual(pre, [{ type: "activity", kind: "tool_started", toolName: "Edit", callId: "x" }]);
  const post = mapValid("hook", { event: "PostToolUse", body: { tool_name: "Edit", tool_use_id: "x" } });
  assert.equal(post[0].kind, "tool_finished");
  const fail = mapValid("hook", { event: "PostToolUseFailure", body: { tool_name: "Edit", tool_use_id: "x" } });
  assert.equal(fail[0].kind, "tool_finished");
});

test("hook Stop → turn ended; SessionEnd → session ended", () => {
  assert.deepEqual(mapValid("hook", { event: "Stop", body: {} }), [{ type: "turn", phase: "ended", reason: "stop" }]);
  assert.deepEqual(mapValid("hook", { event: "SessionEnd", body: {} }), [{ type: "session", phase: "ended" }]);
});

test("hook SessionEnd reason=clear → session cleared (not ended)", () => {
  assert.deepEqual(mapValid("hook", { event: "SessionEnd", body: { reason: "clear" } }),
    [{ type: "session", phase: "cleared" }]);
  assert.deepEqual(mapValid("hook", { event: "SessionEnd", body: { reason: "other" } }),
    [{ type: "session", phase: "ended" }]);
});

test("tool_running / tool_done → activity carrying lifecycle detail", () => {
  assert.deepEqual(mapValid("tool_running", { toolName: "Bash", toolUseId: "t1", input: { cmd: "ls" }, parentAgentToolUseId: "agent_1" }),
    [{ type: "activity", kind: "tool_started", toolName: "Bash", callId: "t1", input: { cmd: "ls" }, parentCallId: "agent_1" }]);
  // No parent / no input → empty input + null parent (a top-level tool pulse).
  assert.deepEqual(mapValid("tool_running", { toolName: "Bash", toolUseId: "t1" }),
    [{ type: "activity", kind: "tool_started", toolName: "Bash", callId: "t1", input: {}, parentCallId: null }]);
  assert.deepEqual(mapValid("tool_done", { toolName: "Bash", toolUseId: "t1", result: "ok" }),
    [{ type: "activity", kind: "tool_finished", toolName: "Bash", callId: "t1", result: "ok", isError: false }]);
});

test("heartbeat → activity alive", () => {
  assert.deepEqual(mapValid("heartbeat", {}), [{ type: "activity", kind: "alive" }]);
});

test("lifecycle pty_exit maps exit codes to outcome", () => {
  const cases: Array<[number, string]> = [[0, "success"], [129, "success"], [143, "killed"], [1, "crashed"]];
  for (const [code, outcome] of cases) {
    const out = mapValid("lifecycle", { phase: "pty_exit", code });
    assert.deepEqual(out, [{ type: "session", phase: "ended", outcome }]);
  }
});

test("lifecycle prompt_sent → turn started", () => {
  assert.deepEqual(mapValid("lifecycle", { phase: "prompt_sent" }), [{ type: "turn", phase: "started" }]);
});

test("lifecycle delivery_failed → turn error", () => {
  assert.deepEqual(mapValid("lifecycle", { phase: "delivery_failed", text: "lost" }),
    [{ type: "turn", phase: "error", reason: "delivery_failed" }]);
});

test("unknown / state events translate to nothing", () => {
  assert.deepEqual(toCanonicalEvents("state", { state: "WORKING" }), []);
  assert.deepEqual(toCanonicalEvents("bogus", {}), []);
  assert.deepEqual(toCanonicalEvents("jsonl", { kind: "weird" }), []);
});

test("malformed payloads never throw", () => {
  assert.doesNotThrow(() => toCanonicalEvents("jsonl", null));
  assert.doesNotThrow(() => toCanonicalEvents("usage", undefined));
  assert.doesNotThrow(() => toCanonicalEvents("hook", 42));
});
