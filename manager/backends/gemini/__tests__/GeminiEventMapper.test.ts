import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createGeminiEventMapper, eosToolCall, shellCommand } from "../GeminiEventMapper.ts";

const EOS = ["orchestrator", "worker"];
const mapper = () => {
  const m = createGeminiEventMapper({ idPrefix: "p", mcpServers: EOS });
  m.setModel("gemini-2.5-pro");
  m.startTurn();
  return m;
};
const text = (t: string) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } });
const thought = (t: string) => ({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: t } });

describe("GeminiEventMapper", () => {
  it("streams text as one block until the channel changes, then closes it durably", () => {
    const m = mapper();
    const events = [thought("plan"), text("Hel"), text("lo")].flatMap((u) => m.update(u));
    assert.deepEqual(events, [
      { type: "delta", channel: "reasoning", phase: "start", blockId: "p:1:1", text: "plan" },
      { type: "delta", channel: "reasoning", phase: "stop", blockId: "p:1:1", text: "" },
      { type: "message", role: "assistant", blocks: [{ type: "reasoning", text: "plan", blockId: "p:1:1" }], model: "gemini-2.5-pro" },
      { type: "delta", channel: "text", phase: "start", blockId: "p:1:2", text: "Hel" },
      { type: "delta", channel: "text", phase: "append", blockId: "p:1:2", text: "lo" },
    ]);
    assert.deepEqual(m.endTurn({ stopReason: "end_turn" }), [
      { type: "delta", channel: "text", phase: "stop", blockId: "p:1:2", text: "" },
      { type: "message", role: "assistant", blocks: [{ type: "text", text: "Hello", blockId: "p:1:2" }], model: "gemini-2.5-pro" },
      { type: "turn", phase: "ended" },
    ]);
  });

  it("a tool call closes the open block; its result follows once, as a tool message", () => {
    const m = mapper();
    m.update(text("Let me look."));
    const call = { sessionUpdate: "tool_call", toolCallId: "read_file-1", status: "in_progress", title: "src/a.ts", kind: "read", locations: [{ path: "/repo/src/a.ts" }] };
    const events = m.update(call);
    assert.equal(events.at(-1)?.type, "message");
    assert.deepEqual((events.at(-1) as { blocks: unknown[] }).blocks, [{ type: "tool_call", callId: "read_file-1", name: "Read", input: { file_path: "/repo/src/a.ts" } }]);
    assert.deepEqual(m.update(call), []);
    assert.deepEqual(m.update({ sessionUpdate: "tool_call_update", toolCallId: "read_file-1", status: "in_progress" }), []);
    assert.deepEqual(m.update({ sessionUpdate: "tool_call_update", toolCallId: "read_file-1", status: "completed", content: [{ type: "content", content: { type: "text", text: "ok" } }] }), [
      { type: "message", role: "tool", blocks: [{ type: "tool_result", callId: "read_file-1", isError: false, content: "ok" }] },
    ]);
  });

  it("a declined call gets a result of its own; interrupts and failures end the turn accordingly", () => {
    const m = mapper();
    assert.deepEqual(m.declined("run_shell_command-2"), [
      { type: "message", role: "tool", blocks: [{ type: "tool_result", callId: "run_shell_command-2", isError: true, content: "Declined — not run." }] },
    ]);
    assert.deepEqual(m.endTurn({ stopReason: "cancelled" }), [{ type: "turn", phase: "aborted", reason: "interrupted" }]);
    assert.deepEqual(m.endTurn({ error: "Rate limit exceeded." }), [{ type: "turn", phase: "error", reason: "Rate limit exceeded." }]);
  });
});

describe("eosToolCall — Gemini's tools under the names Eos gates and renders", () => {
  it("a shell command is Bash, its title stripped to the command", () => {
    assert.equal(shellCommand("git status [current working directory /repo] (Show status)"), "git status");
    assert.equal(shellCommand("npm test [in app]"), "npm test");
    assert.equal(shellCommand("sleep 5 [in .] [background]"), "sleep 5");
    assert.deepEqual(eosToolCall({ toolCallId: "run_shell_command-1", kind: "execute", title: "ls -la [in src]" }, EOS), { name: "Bash", input: { command: "ls -la" } });
  });

  it("an edit is Edit, a new file Write — by the diff's path", () => {
    const diff = (kind: string) => ({ toolCallId: "write_file-1", kind: "edit", title: "x", content: [{ type: "diff", path: "/repo/a.ts", oldText: "", newText: "x", _meta: { kind } }] });
    assert.deepEqual(eosToolCall(diff("add"), EOS), { name: "Write", input: { file_path: "/repo/a.ts" } });
    assert.deepEqual(eosToolCall(diff("modify"), EOS), { name: "Edit", input: { file_path: "/repo/a.ts" } });
  });

  it("Eos's MCP tools keep their mcp__<server>__<tool> names and JSON args", () => {
    assert.deepEqual(
      eosToolCall({ toolCallId: "mcp_orchestrator_spawn_worker-1727000000000", kind: "other", title: `{"from":"reviewer"}` }, EOS),
      { name: "mcp__orchestrator__spawn_worker", input: { from: "reviewer" } },
    );
    assert.equal(eosToolCall({ toolCallId: "mcp_github_create_issue-1", kind: "other", title: "{}" }, EOS).name, "mcp_github_create_issue");
  });
});
