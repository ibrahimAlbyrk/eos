import { describe, it, expect } from "vitest";
import { buildBlocks } from "./messageParser.js";
import { foldTurns } from "./turnFold.js";

// Visual answers in the transcript: a present / present_app call is a "view"
// block (content, not a tool row) and stays in view when the turn folds.

let id = 0;
const ev = (type, payload, ts) => ({ id: ++id, type, ts, payload: JSON.stringify(payload) });
const assistant = (blocks, ts) => ev("agent_event", { type: "message", role: "assistant", blocks }, ts);
const toolMsg = (blocks, ts) => ev("agent_event", { type: "message", role: "tool", blocks }, ts);
const turnEnd = (ts) => ev("agent_event", { type: "turn", phase: "completed" }, ts);
const spec = { title: "Kadıköy'de bu akşam", ui: "<Text>x</Text>", summary: "6 yer" };

describe("messageParser — view blocks", () => {
  it("a present call becomes a view block carrying its input and result", () => {
    const blocks = buildBlocks([
      ev("user_message", { text: "find a place" }, 1),
      assistant([{ type: "tool_call", callId: "c1", name: "mcp__orchestrator__present", input: spec }], 2),
      toolMsg([{ type: "tool_result", callId: "c1", content: "view v_abcdefghijkl rendered · 6 places", isError: false }], 3),
      turnEnd(4),
    ]);
    const view = blocks.find((b) => b.kind === "view");
    expect(view).toBeTruthy();
    expect(view.tool.input).toEqual(spec);
    expect(view.tool.result).toMatchObject({ text: "view v_abcdefghijkl rendered · 6 places", isError: false });
    expect(blocks.some((b) => b.kind === "tool" || b.kind === "toolGroup")).toBe(false);
  });

  it("present_app on the worker server too, and never merged into a tool group", () => {
    const blocks = buildBlocks([
      assistant([
        { type: "tool_call", callId: "r1", name: "Read", input: { file_path: "/a" } },
        { type: "tool_call", callId: "a1", name: "mcp__worker__present_app", input: { title: "App", html: "<p>x</p>", summary: "s" } },
        { type: "tool_call", callId: "r2", name: "Read", input: { file_path: "/b" } },
      ], 1),
    ]);
    expect(blocks.map((b) => b.kind)).toEqual(["tool", "view", "tool"]);
  });

  it("a user_message with a view action keeps it for the reply chip", () => {
    const action = { viewId: "v_abcdefghijkl", label: "Masa ayırt", viewTitle: "Kadıköy'de bu akşam" };
    const [b] = buildBlocks([ev("user_message", { text: "Masa ayırt", action }, 1)]);
    expect(b).toMatchObject({ kind: "user", text: "Masa ayırt", action });
    const [plain] = buildBlocks([ev("user_message", { text: "hi" }, 1)]);
    expect(plain.action).toBeUndefined();
  });
});

describe("turnFold — views stay pinned", () => {
  const key = (b, i) => `${b.kind}-${i}`;
  const view = { kind: "view", tool: { id: "c1", name: "mcp__orchestrator__present" }, ts: 3 };

  it("a finished turn folds its tools; the view and the reply stay in view", () => {
    const blocks = [
      { kind: "user", text: "q", ts: 0 },
      { kind: "thinking", text: "t", ts: 1 },
      { kind: "tool", tool: { id: "r", name: "WebSearch" }, ts: 2 },
      view,
      { kind: "assistant", text: "done", ts: 4 },
    ];
    const { items } = foldTurns(blocks, key);
    expect(items.map((it) => (it.kind === "fold" ? "fold" : it.block.kind))).toEqual(["user", "fold", "view", "assistant"]);
    expect(items[1].work.map((b) => b.kind)).toEqual(["thinking", "tool"]);
  });

  it("a turn that ends on the view folds its work behind it", () => {
    const blocks = [
      { kind: "user", text: "q", ts: 0 },
      { kind: "tool", tool: { id: "r", name: "WebSearch" }, ts: 2 },
      view,
    ];
    const { items } = foldTurns(blocks, key);
    expect(items.map((it) => (it.kind === "fold" ? "fold" : it.block.kind))).toEqual(["user", "fold", "view"]);
  });

  it("never folds while the turn is still live", () => {
    const blocks = [{ kind: "tool", tool: { id: "r", name: "Read" }, ts: 1 }, view];
    const { items } = foldTurns(blocks, key, { live: true });
    expect(items.every((it) => it.kind === "block")).toBe(true);
  });
});
