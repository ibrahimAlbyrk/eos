import { describe, it, expect } from "vitest";
import { buildBlocks } from "./messageParser.js";
import { foldTurns, turnBounds } from "./turnFold.js";

// A Workflow call in the transcript: its own "workflow" block carrying the run's
// start and end events, pinned when the turn folds.

let id = 0;
const ev = (type, payload, ts) => ({ id: ++id, type, ts, payload: JSON.stringify(payload) });
const assistant = (blocks, ts) => ev("agent_event", { type: "message", role: "assistant", blocks }, ts);
const toolMsg = (blocks, ts) => ev("agent_event", { type: "message", role: "tool", blocks }, ts);
const text = (t, ts) => assistant([{ type: "text", text: t }], ts);
const turnEnd = (ts) => ev("agent_event", { type: "turn", phase: "ended" }, ts);
const read = (callId, ts) => [
  assistant([{ type: "tool_call", callId, name: "Read", input: { file_path: "/p/a.ts" } }], ts),
  toolMsg([{ type: "tool_result", callId, content: "x", isError: false }], ts + 1),
];

const SCRIPT = "export const meta = {\n  name: 'review-changes',\n  phases: [{ title: 'Review' }],\n}\n";
const launch = (ts) => [
  assistant([{ type: "tool_call", callId: "wf1", name: "Workflow", input: { script: SCRIPT } }], ts),
  toolMsg([{ type: "tool_result", callId: "wf1", content: "Workflow launched in background. Task ID: t1", isError: false }], ts + 1),
  ev("agent_event", { type: "workflow_started", callId: "wf1", taskId: "t1", name: "review-changes" }, ts + 2),
];
const done = (ts) => ev("agent_event", { type: "workflow_completed", callId: "wf1", taskId: "t1", status: "completed", snapshot: { phases: [], agents: [], logs: [] } }, ts);

describe("messageParser — workflow blocks", () => {
  it("a Workflow call is its own block, never merged with the tools around it", () => {
    const blocks = buildBlocks([ev("user_message", { text: "review" }, 1), ...read("r1", 2), ...launch(10), ...read("r2", 20), turnEnd(30)]);
    expect(blocks.map((b) => b.kind)).toEqual(["user", "tool", "workflow", "tool"]);
    const wf = blocks[2];
    expect(wf.tool.input.script).toBe(SCRIPT);
    expect(wf.started).toMatchObject({ taskId: "t1", name: "review-changes", ts: 12 });
    expect(wf.completed).toBe(null);
  });

  it("carries the run's end once it arrives, even in a later turn", () => {
    const blocks = buildBlocks([ev("user_message", { text: "review" }, 1), ...launch(10), text("Started.", 15), turnEnd(16), done(90)]);
    expect(blocks.find((b) => b.kind === "workflow").completed).toMatchObject({ status: "completed", ts: 90 });
  });
});

describe("turnFold — workflow blocks", () => {
  const keyOf = (b, i) => `${b.kind}-${i}`;
  const fold = (events) => foldTurns(buildBlocks(events), keyOf, turnBounds(events));
  const kinds = (items) => items.map((it) => (it.kind === "fold" ? "fold" : it.block.kind));

  it("nothing folds while the turn that launched it goes on", () => {
    const { items, liveRunKeys } = fold([ev("user_message", { text: "go" }, 1), ...read("r1", 2), ...launch(10), text("Started it.", 15)]);
    expect(items.every((it) => it.kind === "block")).toBe(true);
    expect(liveRunKeys).toHaveLength(1);
  });

  it("the turn folds once it ends, the card staying in view while the run works on", () => {
    const { items } = fold([ev("user_message", { text: "go" }, 1), ...read("r1", 2), ...launch(10), text("Started it.", 15), turnEnd(16)]);
    expect(kinds(items)).toEqual(["user", "fold", "workflow", "assistant"]);
  });

  it("the run's end leaves the folded turn as it was", () => {
    const { items } = fold([ev("user_message", { text: "go" }, 1), ...read("r1", 2), ...launch(10), text("Started it.", 15), turnEnd(16), done(40)]);
    expect(kinds(items)).toEqual(["user", "fold", "workflow", "assistant"]);
  });
});
