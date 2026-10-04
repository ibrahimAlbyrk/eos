import { describe, it, expect } from "vitest";
import { foldTurns } from "./turnFold.js";

const keyOf = (b, i) => `${b.kind}-${i}`;
const tool = (name, input = {}, extra = {}) => ({ id: `${name}-${Math.random()}`, name, input, ...extra });
const read = (path) => tool("Read", { file_path: path }, { verb: "read" });
const edit = (path) => tool("Edit", { file_path: path }, { verb: "edit" });
const bash = (command) => tool("Bash", { command }, { verb: "bash" });

const turn = [
  { kind: "user", text: "fix the flicker", ts: 1000 },
  { kind: "thinking", text: "hmm", ts: 2000 },
  { kind: "toolGroup", tools: [read("/a/useLive.js"), read("/a/List.jsx")], ts: 3000 },
  { kind: "assistant", text: "Found it.", ts: 4000 },
  { kind: "tool", tool: edit("/a/useLive.js"), ts: 5000 },
  { kind: "tool", tool: bash("npx vitest run"), ts: 6000 },
  { kind: "assistant", text: "Fixed.", ts: 253000 },
];

const kinds = (items) => items.map((it) => (it.kind === "fold" ? "fold" : it.block.kind));

describe("foldTurns", () => {
  it("folds a finished turn's work and keeps the prompt and final reply", () => {
    const { items, liveRunKeys } = foldTurns(turn, keyOf);
    expect(kinds(items)).toEqual(["user", "fold", "assistant"]);
    const fold = items[1];
    expect(fold.key).toBe("fold-thinking-1");
    expect(fold.work).toEqual(turn.slice(1, 6));
    expect(fold.durationMs).toBe(252000);
    expect(items[2]).toEqual({ kind: "block", block: turn[6], index: 6 });
    expect(liveRunKeys).toEqual([]);
  });

  it("never folds the run still streaming at the tail, and names it", () => {
    const { items, liveRunKeys } = foldTurns(turn, keyOf, { live: true });
    expect(kinds(items)).toEqual(turn.map((b) => b.kind));
    expect(liveRunKeys).toEqual(["thinking-1"]);
  });

  it("folds earlier turns while the agent works on the next one", () => {
    const blocks = [...turn, { kind: "user", text: "next", ts: 300000 }, { kind: "tool", tool: read("/b"), ts: 301000 }];
    const { items, liveRunKeys } = foldTurns(blocks, keyOf, { live: true });
    expect(kinds(items)).toEqual(["user", "fold", "assistant", "user", "tool"]);
    expect(liveRunKeys).toEqual(["tool-8"]);
  });

  it("keeps a turn open while its background subagents still work, then folds it", () => {
    const blocks = (status) => [
      { kind: "user", text: "research", ts: 1 },
      { kind: "subagents", runs: [{ toolUseId: "a", status: "completed" }, { toolUseId: "b", status }], ts: 2 },
      { kind: "assistant", text: "Started two agents.", ts: 3 },
    ];
    const waiting = foldTurns(blocks("running"), keyOf);
    expect(kinds(waiting.items)).toEqual(["user", "subagents", "assistant"]);
    expect(waiting.liveRunKeys).toEqual(["subagents-1"]);
    const done = foldTurns(blocks("completed"), keyOf);
    expect(kinds(done.items)).toEqual(["user", "fold", "assistant"]);
    expect(done.liveRunKeys).toEqual([]);
  });

  it("leaves a turn alone when it did not end on a reply or did no work", () => {
    const noReply = [{ kind: "user", text: "go", ts: 1 }, { kind: "tool", tool: read("/a"), ts: 2 }];
    expect(kinds(foldTurns(noReply, keyOf).items)).toEqual(["user", "tool"]);
    const onlyThought = [{ kind: "user", text: "hi", ts: 1 }, { kind: "thinking", text: "…", ts: 2 }, { kind: "assistant", text: "hello", ts: 3 }];
    expect(kinds(foldTurns(onlyThought, keyOf).items)).toEqual(["user", "thinking", "assistant"]);
  });

  it("keeps pinned tools in view between the fold and the reply", () => {
    const blocks = [
      { kind: "user", text: "make a page", ts: 1 },
      { kind: "tool", tool: edit("/a.html"), ts: 2 },
      { kind: "tool", tool: tool("Artifact", { file_path: "/a.html" }), ts: 3 },
      { kind: "tool", tool: bash("ls"), ts: 4 },
      { kind: "assistant", text: "Published.", ts: 5 },
    ];
    const { items } = foldTurns(blocks, keyOf);
    expect(kinds(items)).toEqual(["user", "fold", "tool", "assistant"]);
    expect(items[2].block.tool.name).toBe("Artifact");
    expect(items[1].work.map((b) => b.tool.name)).toEqual(["Edit", "Bash"]);
  });

  it("does not fold across a block that is not the agent's own work", () => {
    const blocks = [
      { kind: "user", text: "go", ts: 1 },
      { kind: "tool", tool: read("/a"), ts: 2 },
      { kind: "report", text: "worker done", ts: 3 },
      { kind: "tool", tool: read("/b"), ts: 4 },
      { kind: "assistant", text: "done", ts: 5 },
    ];
    expect(kinds(foldTurns(blocks, keyOf).items)).toEqual(["user", "tool", "report", "fold", "assistant"]);
  });
});
