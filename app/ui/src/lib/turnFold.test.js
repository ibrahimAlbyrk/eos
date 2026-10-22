import { describe, it, expect } from "vitest";
import { foldTurns, turnBounds } from "./turnFold.js";
import { buildBlocks, sortBlocksByTs } from "./messageParser.js";
import { collectSubagents, groupSubagentRuns } from "./subagentRuns.js";

// Like Messages' blockKey fallback: stable per block, not per position.
const keyOf = (b) => `${b.kind}-${b.ts}`;
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
const ended = { starts: [1000], lastEnd: 253500 };

const kinds = (items) => items.map((it) => (it.kind === "fold" ? "fold" : it.block.kind));
const folds = (items) => items.filter((it) => it.kind === "fold");

describe("foldTurns", () => {
  it("folds a finished turn's work and keeps the prompt and final reply", () => {
    const { items, liveRunKeys } = foldTurns(turn, keyOf, ended);
    expect(kinds(items)).toEqual(["user", "fold", "assistant"]);
    const fold = items[1];
    expect(fold.key).toBe("fold-assistant-253000");
    expect(fold.runKey).toBe("thinking-2000");
    expect(fold.work).toEqual(turn.slice(1, 6));
    expect(fold.durationMs).toBe(252000);
    expect(items[2]).toEqual({ kind: "block", block: turn[6], index: 6 });
    expect(liveRunKeys).toEqual([]);
  });

  it("never folds a turn whose end isn't logged yet, and names it", () => {
    const { items, liveRunKeys } = foldTurns(turn, keyOf, { starts: [1000], lastEnd: 500 });
    expect(kinds(items)).toEqual(turn.map((b) => b.kind));
    expect(liveRunKeys).toEqual(["thinking-2000"]);
  });

  it("folds earlier turns while the agent works on the next one", () => {
    const blocks = [...turn, { kind: "user", text: "next", ts: 300000 }, { kind: "tool", tool: read("/b"), ts: 301000 }];
    const { items, liveRunKeys } = foldTurns(blocks, keyOf, { starts: [1000, 300000], lastEnd: 253500 });
    expect(kinds(items)).toEqual(["user", "fold", "assistant", "user", "tool"]);
    expect(liveRunKeys).toEqual(["tool-301000"]);
  });

  it("keeps a folded turn as it is while the agent wakes for its subagent's report", () => {
    const prompt = { kind: "user", text: "research", ts: 1 };
    const look = { kind: "tool", tool: read("/a"), ts: 2 };
    const batch = (status) => ({ kind: "subagents", runs: [{ toolUseId: "a", background: true, status }], ts: 3 });
    const started = { kind: "assistant", text: "Started an agent.", ts: 4 };
    const firstFold = (items) => {
      const [fold] = folds(items);
      return { key: fold.key, work: fold.work, durationMs: fold.durationMs };
    };

    // The turn ends while its subagent still runs: it folds, the subagent line stays in view.
    const waiting = foldTurns([prompt, look, batch("running"), started], keyOf, { starts: [1], lastEnd: 5 });
    expect(kinds(waiting.items)).toEqual(["user", "fold", "subagents", "assistant"]);
    expect(waiting.liveRunKeys).toEqual([]);
    const sealed = firstFold(waiting.items);

    // The subagent finishes.
    const done = foldTurns([prompt, look, batch("completed"), started], keyOf, { starts: [1], lastEnd: 5 });
    expect(firstFold(done.items)).toEqual(sealed);

    // Its report wakes the agent: a new turn streams in below.
    const woken = [prompt, look, batch("completed"), started, { kind: "thinking", live: true, ts: 11 }, { kind: "tool", tool: read("/b"), ts: 12 }];
    const working = foldTurns(woken, keyOf, { starts: [1, 10], lastEnd: 5 });
    expect(kinds(working.items)).toEqual(["user", "fold", "subagents", "assistant", "thinking", "tool"]);
    expect(firstFold(working.items)).toEqual(sealed);
    expect(working.liveRunKeys).toEqual(["thinking-11"]);

    // The woken turn ends: it folds on its own, timed from its start.
    const answered = foldTurns([...woken, { kind: "assistant", text: "Findings.", ts: 20 }], keyOf, { starts: [1, 10], lastEnd: 21 });
    expect(kinds(answered.items)).toEqual(["user", "fold", "subagents", "assistant", "fold", "assistant"]);
    expect(firstFold(answered.items)).toEqual(sealed);
    expect(folds(answered.items)[1].durationMs).toBe(10);
  });

  it("folds a foreground subagent batch with the rest of the work", () => {
    const blocks = [
      { kind: "user", text: "look", ts: 1 },
      { kind: "subagents", runs: [{ toolUseId: "a", background: false, status: "completed" }], ts: 2 },
      { kind: "assistant", text: "Done.", ts: 3 },
    ];
    const { items } = foldTurns(blocks, keyOf, { starts: [1], lastEnd: 4 });
    expect(kinds(items)).toEqual(["user", "fold", "assistant"]);
    expect(items[1].work.map((b) => b.kind)).toEqual(["subagents"]);
  });

  it("leaves a turn alone when it did not end on a reply or did no work", () => {
    const noReply = [{ kind: "user", text: "go", ts: 1 }, { kind: "tool", tool: read("/a"), ts: 2 }];
    expect(kinds(foldTurns(noReply, keyOf, { starts: [1], lastEnd: 3 }).items)).toEqual(["user", "tool"]);
    const onlyThought = [{ kind: "user", text: "hi", ts: 1 }, { kind: "thinking", text: "…", ts: 2 }, { kind: "assistant", text: "hello", ts: 3 }];
    expect(kinds(foldTurns(onlyThought, keyOf, { starts: [1], lastEnd: 4 }).items)).toEqual(["user", "thinking", "assistant"]);
  });

  it("keeps pinned tools in view between the fold and the reply", () => {
    const blocks = [
      { kind: "user", text: "make a page", ts: 1 },
      { kind: "tool", tool: edit("/a.html"), ts: 2 },
      { kind: "tool", tool: tool("Artifact", { file_path: "/a.html" }), ts: 3 },
      { kind: "tool", tool: bash("ls"), ts: 4 },
      { kind: "assistant", text: "Published.", ts: 5 },
    ];
    const { items } = foldTurns(blocks, keyOf, { starts: [1], lastEnd: 6 });
    expect(kinds(items)).toEqual(["user", "fold", "tool", "assistant"]);
    expect(items[2].block.tool.name).toBe("Artifact");
    expect(items[1].work.map((b) => b.tool.name)).toEqual(["Edit", "Bash"]);
  });

  it("does not fold across a block that is not the agent's own work, nor before the turn ends", () => {
    const blocks = [
      { kind: "user", text: "go", ts: 1 },
      { kind: "tool", tool: read("/a"), ts: 2 },
      { kind: "assistant", text: "checking", ts: 3 },
      { kind: "report", text: "worker done", ts: 4 },
      { kind: "tool", tool: read("/b"), ts: 5 },
      { kind: "assistant", text: "done", ts: 6 },
    ];
    expect(kinds(foldTurns(blocks, keyOf, { starts: [1], lastEnd: 0 }).items)).toEqual(blocks.map((b) => b.kind));
    expect(kinds(foldTurns(blocks, keyOf, { starts: [1], lastEnd: 7 }).items)).toEqual(["user", "fold", "assistant", "report", "fold", "assistant"]);
  });

  it("keeps a fold's key when the window's oldest rows trim off", () => {
    const whole = folds(foldTurns(turn, keyOf, ended).items)[0];
    const trimmed = folds(foldTurns(turn.slice(2), keyOf, ended).items)[0];
    expect(trimmed.key).toBe(whole.key);
  });
});

describe("foldTurns over a logged background-subagent wake", () => {
  let id = 0;
  const row = (type, payload, ts) => ({ id: ++id, type, payload: JSON.stringify(payload), ts });
  const agent = (payload, ts) => row("agent_event", payload, ts);
  const say = (blocks, ts) => agent({ type: "message", role: "assistant", blocks }, ts);
  const result = (callId, content, ts) => agent({ type: "message", role: "tool", blocks: [{ type: "tool_result", callId, content, isError: false }] }, ts);
  const turnStart = (ts) => [row("state", { state: "WORKING", from: "IDLE" }, ts), agent({ type: "turn", phase: "started" }, ts)];
  const turnEnd = (ts) => [agent({ type: "turn", phase: "ended" }, ts), row("state", { state: "IDLE", from: "WORKING" }, ts)];
  const readFile = (callId, ts) => [say([{ type: "tool_call", callId, name: "Read", input: { file_path: "/a" } }], ts), result(callId, "x", ts + 1)];

  // What Messages renders: parsed, ordered, subagent launches grouped, folded by the log's turns.
  const render = (rows) => {
    const parsed = sortBlocksByTs(buildBlocks(rows));
    return foldTurns(groupSubagentRuns(parsed, collectSubagents(parsed)), keyOf, turnBounds(rows));
  };
  const firstFold = (items) => {
    const [fold] = folds(items);
    return { key: fold.key, work: fold.work.map(keyOf), durationMs: fold.durationMs };
  };

  const turn1 = [
    row("user_message", { text: "research" }, 1),
    ...turnStart(1),
    ...readFile("r1", 2),
    say([{ type: "tool_call", callId: "AG", name: "Agent", input: { description: "dig", prompt: "dig", run_in_background: true }, spawnsSubagent: true }], 4),
    result("AG", "launched", 5),
    agent({ type: "subagent_started", callId: "AG", agentId: "a1" }, 6),
    say([{ type: "text", text: "Started an agent." }], 7),
    ...turnEnd(8),
  ];
  const completed = agent({ type: "subagent_completed", callId: "AG", agentId: "a1", status: "completed", result: "found it" }, 20);
  const turn2 = [...turnStart(21), ...readFile("r2", 22)];
  const answered = [say([{ type: "text", text: "Findings." }], 30), ...turnEnd(31)];

  it("never reopens the first turn while the subagent finishes and the agent works on its report", () => {
    const sealed = firstFold(render(turn1).items);
    expect(kinds(render(turn1).items)).toEqual(["user", "fold", "subagents", "assistant"]);
    expect(render(turn1).items[2].block.runs[0].status).toBe("running");

    expect(firstFold(render([...turn1, completed]).items)).toEqual(sealed);

    const working = render([...turn1, completed, ...turn2]);
    expect(kinds(working.items)).toEqual(["user", "fold", "subagents", "assistant", "tool"]);
    expect(firstFold(working.items)).toEqual(sealed);

    const done = render([...turn1, completed, ...turn2, ...answered]);
    expect(kinds(done.items)).toEqual(["user", "fold", "subagents", "assistant", "fold", "assistant"]);
    expect(firstFold(done.items)).toEqual(sealed);
    expect(folds(done.items)[1].durationMs).toBe(9);
  });
});

describe("turnBounds", () => {
  const row = (type, payload, ts) => ({ type, payload: JSON.stringify(payload), ts });

  it("reads turn starts and the latest end from every lane's rows", () => {
    const events = [
      row("state", { state: "SPAWNING", from: "DONE" }, 1),
      row("state", { state: "WORKING", from: "SPAWNING" }, 2),
      row("agent_event", { type: "turn", phase: "started" }, 3),
      row("agent_event", { type: "message", role: "assistant", blocks: [] }, 4),
      row("agent_event", { type: "turn", phase: "ended" }, 5),
      row("state", { state: "IDLE", from: "WORKING" }, 6),
      row("state", { state: "WORKING", from: "IDLE" }, 9),
      row("lifecycle", { phase: "interrupted" }, 12),
    ];
    expect(turnBounds(events)).toEqual({ starts: [1, 3, 9], lastEnd: 12 });
  });

  it("has no end before any turn ended", () => {
    expect(turnBounds([row("agent_event", { type: "turn", phase: "started" }, 1)])).toEqual({ starts: [1], lastEnd: -Infinity });
  });
});
