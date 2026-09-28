import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCodexEventMapper, parseUnifiedDiff, unwrapShellCommand } from "../CodexEventMapper.ts";

const item = (over: Record<string, unknown>) => ({ id: "i1", ...over });

describe("CodexEventMapper", () => {
  it("streams agent text, then lands it as a durable text block", () => {
    const m = createCodexEventMapper();
    m.setModel("gpt-x");
    assert.deepEqual(m.map("turn/started", { turn: { id: "t1" } }), [{ type: "turn", phase: "started" }]);
    assert.deepEqual(m.map("item/agentMessage/delta", { itemId: "i1", delta: "Hel" }), [{ type: "delta", channel: "text", phase: "start", blockId: "i1", text: "Hel" }]);
    assert.deepEqual(m.map("item/agentMessage/delta", { itemId: "i1", delta: "lo" }), [{ type: "delta", channel: "text", phase: "append", blockId: "i1", text: "lo" }]);
    assert.deepEqual(m.map("item/completed", { item: item({ type: "agentMessage", text: "Hello" }) }), [
      { type: "delta", channel: "text", phase: "stop", blockId: "i1", text: "" },
      { type: "message", role: "assistant", blocks: [{ type: "text", text: "Hello", blockId: "i1" }], model: "gpt-x" },
    ]);
  });

  it("reasoning summaries stream on their own channel", () => {
    const m = createCodexEventMapper();
    const [d] = m.map("item/reasoning/summaryTextDelta", { itemId: "r1", delta: "think" });
    assert.deepEqual(d, { type: "delta", channel: "reasoning", phase: "start", blockId: "r1:reasoning", text: "think" });
    const out = m.map("item/completed", { item: { id: "r1", type: "reasoning", summary: ["a", "b"], content: [] } });
    assert.deepEqual(out[1], { type: "message", role: "assistant", blocks: [{ type: "reasoning", text: "a\n\nb", blockId: "r1:reasoning" }], model: null });
  });

  it("a command is a Bash call on start and its output on completion", () => {
    const m = createCodexEventMapper();
    const started = m.map("item/started", { item: item({ type: "commandExecution", command: "ls", status: "inProgress" }) });
    assert.deepEqual(started, [{ type: "message", role: "assistant", blocks: [{ type: "tool_call", callId: "i1", name: "Bash", input: { command: "ls" } }], model: null }]);
    const done = m.map("item/completed", { item: item({ type: "commandExecution", command: "ls", status: "completed", exitCode: 0, aggregatedOutput: "a\nb" }) });
    assert.deepEqual(done, [{ type: "message", role: "tool", blocks: [{ type: "tool_result", callId: "i1", isError: false, content: "a\nb" }] }]);
  });

  it("a failing or declined command is an error result; a skipped start still emits the call", () => {
    const m = createCodexEventMapper();
    const out = m.map("item/completed", { item: item({ type: "commandExecution", command: "rm x", status: "declined", exitCode: null, aggregatedOutput: null }) });
    assert.equal(out.length, 2);
    assert.deepEqual(out[1], { type: "message", role: "tool", blocks: [{ type: "tool_result", callId: "i1", isError: true, content: "Declined — not run." }] });
  });

  it("a file change is one Edit/Write per file, with the diff as its patch", () => {
    const m = createCodexEventMapper();
    const diff = "--- a/x.ts\n+++ b/x.ts\n@@ -3,2 +3,2 @@\n-old\n+new\n ctx";
    const fc = item({ type: "fileChange", status: "completed", changes: [
      { path: "/r/x.ts", kind: { type: "update", move_path: null }, diff },
      { path: "/r/y.ts", kind: { type: "add" }, diff: "@@ -0,0 +1 @@\n+hi" },
    ] });
    const [call, result] = m.map("item/completed", { item: fc });
    assert.deepEqual(call, { type: "message", role: "assistant", model: null, blocks: [
      { type: "tool_call", callId: "i1:0", name: "Edit", input: { file_path: "/r/x.ts" } },
      { type: "tool_call", callId: "i1:1", name: "Write", input: { file_path: "/r/y.ts" } },
    ] });
    const blocks = (result as { blocks: Array<Record<string, unknown>> }).blocks;
    assert.deepEqual(blocks[0].patch, [{ oldStart: 3, newStart: 3, lines: ["-old", "+new", " ctx"] }]);
    assert.equal(blocks[1].isError, false);
  });

  it("an MCP call is mcp__server__tool with its text result", () => {
    const m = createCodexEventMapper();
    const out = m.map("item/completed", { item: item({ type: "mcpToolCall", server: "worker", tool: "report", arguments: { a: 1 }, status: "completed", result: { content: [{ type: "text", text: "ok" }] }, error: null }) });
    assert.deepEqual(out[0], { type: "message", role: "assistant", model: null, blocks: [{ type: "tool_call", callId: "i1", name: "mcp__worker__report", input: { a: 1 } }] });
    assert.deepEqual(out[1], { type: "message", role: "tool", blocks: [{ type: "tool_result", callId: "i1", isError: false, content: "ok" }] });
  });

  it("a plan update becomes a TodoWrite the task panel folds", () => {
    const m = createCodexEventMapper();
    m.map("turn/started", { turn: { id: "t1" } });
    const [call] = m.map("turn/plan/updated", { plan: [{ step: "Read", status: "completed" }, { step: "Fix", status: "inProgress" }] });
    const block = (call as { blocks: Array<{ name: string; input: { todos: unknown[] } }> }).blocks[0];
    assert.equal(block.name, "TodoWrite");
    assert.deepEqual(block.input.todos, [
      { content: "Read", activeForm: "Read", status: "completed" },
      { content: "Fix", activeForm: "Fix", status: "in_progress" },
    ]);
  });

  it("bills each turn only its own tokens, cached input as cache reads", () => {
    const m = createCodexEventMapper();
    m.setModel("gpt-x");
    m.map("turn/started", { turn: { id: "t1" } });
    const ctx = m.map("thread/tokenUsage/updated", { tokenUsage: { total: { inputTokens: 1000, cachedInputTokens: 600, outputTokens: 50 }, last: { inputTokens: 1000, outputTokens: 50 } } });
    assert.deepEqual(ctx, [{ type: "context", tokens: 1050 }]);
    const end = m.map("turn/completed", { turn: { id: "t1", status: "completed" } });
    assert.deepEqual(end, [
      { type: "usage", usage: { inputTokens: 400, outputTokens: 50, cacheReadTokens: 600, cacheWriteTokens: {}, model: "gpt-x" } },
      { type: "turn", phase: "ended" },
    ]);
    m.map("turn/started", { turn: { id: "t2" } });
    m.map("thread/tokenUsage/updated", { tokenUsage: { total: { inputTokens: 1500, cachedInputTokens: 1000, outputTokens: 80 } } });
    const [usage] = m.map("turn/completed", { turn: { id: "t2", status: "completed" } });
    assert.deepEqual(usage, { type: "usage", usage: { inputTokens: 100, outputTokens: 30, cacheReadTokens: 400, cacheWriteTokens: {}, model: "gpt-x" } });
  });

  it("interrupted and failed turns end as aborted / error", () => {
    const m = createCodexEventMapper();
    assert.deepEqual(m.map("turn/completed", { turn: { status: "interrupted" } }), [{ type: "turn", phase: "aborted", reason: "interrupted" }]);
    assert.deepEqual(m.map("turn/completed", { turn: { status: "failed", error: { message: "usage limit" } } }), [{ type: "turn", phase: "error", reason: "usage limit" }]);
  });
});

describe("unwrapShellCommand", () => {
  it("strips the login-shell wrapper Codex adds, unescaping quotes", () => {
    assert.equal(unwrapShellCommand("/bin/zsh -lc 'wc -c hello.txt'"), "wc -c hello.txt");
    assert.equal(unwrapShellCommand(`/bin/bash -lc 'echo '\\''hi'\\'''`), "echo 'hi'");
    assert.equal(unwrapShellCommand("git status"), "git status");
  });
});

describe("parseUnifiedDiff", () => {
  it("keeps hunk lines with absolute starts and drops file headers", () => {
    assert.deepEqual(parseUnifiedDiff("--- a\n+++ b\n@@ -10,2 +12,3 @@ fn\n a\n+b\n-c"), [{ oldStart: 10, newStart: 12, lines: [" a", "+b", "-c"] }]);
    assert.equal(parseUnifiedDiff("no hunks"), undefined);
  });
});
