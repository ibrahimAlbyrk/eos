import { describe, it, expect } from "vitest";
import { buildBlocks } from "./messageParser.js";
import { MORE_EMOJI, QUICK_EMOJI, endedWithNoReply, isReactableChat, isReactionTool, reactionToolKind } from "./reactions.js";

let id = 0;
const ev = (type, payload, ts) => ({ id: ++id, type, ts, payload: JSON.stringify(payload) });
const assistant = (blocks, ts) => ev("agent_event", { type: "message", role: "assistant", blocks }, ts);
const toolMsg = (callId, ts) => ev("agent_event", { type: "message", role: "tool", blocks: [{ type: "tool_result", callId, content: "ok", isError: false }] }, ts);
const turnEnd = (ts) => ev("agent_event", { type: "turn", phase: "ended" }, ts);
const call = (callId, name, input = {}) => ({ type: "tool_call", callId, name, input });
const text = (t) => ({ type: "text", text: t });

describe("the picker's emoji", () => {
  it("offers six quick ones and a grid of whole rows of seven, none twice", () => {
    expect(QUICK_EMOJI).toHaveLength(6);
    expect(MORE_EMOJI.length % 7).toBe(0);
    expect(new Set([...QUICK_EMOJI, ...MORE_EMOJI]).size).toBe(QUICK_EMOJI.length + MORE_EMOJI.length);
  });
});

describe("isReactableChat", () => {
  it("is a focused chat or an orchestrator, never a plain worker", () => {
    expect(isReactableChat({ id: "w", agent_role: "focused" })).toBe(true);
    expect(isReactableChat({ id: "w", is_orchestrator: true })).toBe(true);
    expect(isReactableChat({ id: "w", agent_role: "git" })).toBe(false);
    expect(isReactableChat({ id: "w", parent_id: "o" })).toBe(false);
    expect(isReactableChat(undefined)).toBe(false);
  });
});

describe("the agent's reaction tools", () => {
  it("are told by name on either server", () => {
    expect(reactionToolKind("mcp__worker__react")).toBe("react");
    expect(reactionToolKind("mcp__orchestrator__no_reply")).toBe("no_reply");
    expect(isReactionTool("mcp__orchestrator__react")).toBe(true);
    expect(isReactionTool("mcp__worker__present")).toBe(false);
    expect(isReactionTool("mcp__other__react")).toBe(false);
    expect(isReactionTool(undefined)).toBe(false);
  });

  it("never show in the transcript: the chip is their whole display", () => {
    const blocks = buildBlocks([
      ev("user_message", { text: "thanks!" }, 1),
      assistant([call("r1", "mcp__worker__react", { emoji: "❤️" }), call("n1", "mcp__worker__no_reply")], 2),
      toolMsg("r1", 3),
      toolMsg("n1", 4),
      turnEnd(5),
    ]);
    expect(blocks.map((b) => b.kind)).toEqual(["user"]);
  });

  it("leave the tools around them in their group", () => {
    const blocks = buildBlocks([
      assistant([call("a", "Read", { file_path: "/a" }), call("r", "mcp__orchestrator__react", { emoji: "👍" }), call("b", "Read", { file_path: "/b" })], 1),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].tools.map((t) => t.id)).toEqual(["a", "b"]);
  });
});

describe("a turn a reaction started", () => {
  it("answers in a message of its own, not as more of the one reacted to", () => {
    const blocks = buildBlocks([
      assistant([text("Delete the old branch too?")], 1),
      turnEnd(2),
      assistant([text("Deleted.")], 3),
      turnEnd(4),
    ]);
    expect(blocks.map((b) => b.text)).toEqual(["Delete the old branch too?", "Deleted."]);
    expect(blocks[0].rowId).not.toBe(blocks[1].rowId);
  });
});

describe("endedWithNoReply", () => {
  it("is a newest turn whose last act was no_reply", () => {
    const silent = [assistant([text("Done.")], 1), turnEnd(2), assistant([call("n", "mcp__worker__no_reply")], 3), toolMsg("n", 4), turnEnd(5)];
    expect(endedWithNoReply(silent)).toBe(true);
    const reactedThenSilent = [assistant([call("r", "mcp__worker__react", { emoji: "👍" }), call("n", "mcp__worker__no_reply")], 1), turnEnd(2)];
    expect(endedWithNoReply(reactedThenSilent)).toBe(true);
  });

  it("is not a turn that said something, used another tool last, or an empty log", () => {
    expect(endedWithNoReply([assistant([call("n", "mcp__worker__no_reply")], 1), turnEnd(2), assistant([text("On it.")], 3)])).toBe(false);
    expect(endedWithNoReply([assistant([call("r", "mcp__worker__react", { emoji: "👍" })], 1)])).toBe(false);
    expect(endedWithNoReply([assistant([call("n", "mcp__worker__no_reply"), text("Deleted.")], 1)])).toBe(false);
    expect(endedWithNoReply([ev("user_message", { text: "hi" }, 1)])).toBe(false);
    expect(endedWithNoReply([])).toBe(false);
  });
});
