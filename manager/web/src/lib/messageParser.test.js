import { describe, it, expect } from "vitest";
import { buildBlocks } from "./messageParser.js";

function agentRow(id, ts) {
  return { type: "jsonl", ts, payload: { kind: "tool_use", id, name: "Agent", input: { description: id } } };
}

function toolRunning(toolUseId, ts, parentAgentToolUseId) {
  const payload = { toolName: "Bash", toolUseId, input: { command: "echo" } };
  if (parentAgentToolUseId) payload.parentAgentToolUseId = parentAgentToolUseId;
  return { type: "tool_running", ts, payload };
}

function toolsOf(blocks, agentToolUseId) {
  const run = blocks.find((b) => b.kind === "agentRun" && b.toolUseId === agentToolUseId);
  return (run?.tools ?? []).map((t) => t.id);
}

describe("buildBlocks subagent attribution", () => {
  it("attributes deterministically by parentAgentToolUseId for overlapping spans", () => {
    // Two concurrent Agents whose spans overlap (no tool_result -> endTs=Infinity).
    // Inner Bash tools at ts 200/201 both fall inside both spans, so the old
    // timestamp window assigns both to idA (insertion order). parentAgentToolUseId
    // must split them.
    const events = [
      agentRow("idA", 100),
      agentRow("idB", 101),
      toolRunning("tA", 200, "idA"),
      toolRunning("tB", 201, "idB"),
    ];
    const blocks = buildBlocks(events);
    expect(toolsOf(blocks, "idA")).toEqual(["tA"]);
    expect(toolsOf(blocks, "idB")).toEqual(["tB"]);
    // No top-level tool stream leak.
    expect(blocks.some((b) => b.kind === "tool" && (b.tool.id === "tA" || b.tool.id === "tB"))).toBe(false);
  });

  it("falls back to the timestamp window when parentAgentToolUseId is absent", () => {
    const events = [
      agentRow("idA", 100),
      agentRow("idB", 101),
      toolRunning("tA", 200),
      toolRunning("tB", 201),
    ];
    const blocks = buildBlocks(events);
    const attributed = [...toolsOf(blocks, "idA"), ...toolsOf(blocks, "idB")];
    // Every inner tool lands under exactly one agentRun, and none leak to the
    // top-level tool stream.
    expect(attributed.sort()).toEqual(["tA", "tB"]);
    expect(blocks.some((b) => b.kind === "tool" && (b.tool.id === "tA" || b.tool.id === "tB"))).toBe(false);
  });
});

function mainToolUse(id, ts, name = "Read") {
  return { type: "jsonl", ts, payload: { kind: "tool_use", id, name, input: { file_path: "/x" } } };
}

function mainToolResult(toolUseId, ts, text) {
  return { type: "jsonl", ts, payload: { kind: "tool_result", toolUseId, text, isError: false } };
}

function mainToolDone(toolUseId, ts, result, toolName = "Read") {
  return { type: "tool_done", ts, payload: { toolName, toolUseId, result } };
}

function mainTool(blocks, id) {
  for (const b of blocks) {
    if (b.kind === "tool" && b.tool.id === id) return b.tool;
    if (b.kind === "toolGroup") {
      const t = b.tools.find((x) => x.id === id);
      if (t) return t;
    }
  }
  return null;
}

describe("buildBlocks main-agent tool_done fallback", () => {
  it("clears a stuck-running tool when its tool_result jsonl is missing but tool_done fired", () => {
    const events = [
      mainToolUse("T1", 100),
      mainToolUse("T2", 101),
      mainToolResult("T1", 102, "T1 jsonl"),
      mainToolDone("T1", 103, "T1 hook"),
      mainToolDone("T2", 104, "T2 hook"),
    ];
    const blocks = buildBlocks(events);
    const t2 = mainTool(blocks, "T2");
    expect(t2.done).toBe(true);
    expect(t2.result).toEqual({ text: "T2 hook", isError: false });
  });

  it("keeps the jsonl tool_result when both it and tool_done are present", () => {
    const events = [
      mainToolUse("T1", 100),
      mainToolResult("T1", 101, "jsonl text"),
      mainToolDone("T1", 102, "hook text"),
    ];
    const blocks = buildBlocks(events);
    const t1 = mainTool(blocks, "T1");
    expect(t1.result.text).toBe("jsonl text");
    expect(t1.done).toBe(true);
  });

  it("leaves a tool running when neither tool_result jsonl nor tool_done is present", () => {
    const events = [mainToolUse("T1", 100)];
    const blocks = buildBlocks(events);
    const t1 = mainTool(blocks, "T1");
    expect(t1.result).toBe(null);
    expect(t1.done).toBe(false);
  });

  it("lets attachAskUserAnswers win over a present tool_done", () => {
    const events = [
      mainToolUse("Q1", 100, "AskUserQuestion"),
      mainToolDone("Q1", 101, "hook text", "AskUserQuestion"),
      { type: "user_message", ts: 102, payload: { text: "My answers to your questions: yes" } },
    ];
    const blocks = buildBlocks(events);
    const q1 = mainTool(blocks, "Q1");
    expect(q1.done).toBe(true);
    expect(q1.running).toBe(false);
    expect(q1.result.text.startsWith("My answers to your questions:")).toBe(true);
  });
});

describe("buildBlocks standalone tools", () => {
  it("keeps standalone tools out of toolGroups and splits the surrounding group", () => {
    const events = [
      mainToolUse("T1", 100),
      mainToolUse("T2", 101),
      mainToolUse("S1", 102, "Skill"),
      mainToolUse("T3", 103),
      mainToolUse("T4", 104),
    ];
    const blocks = buildBlocks(events);
    expect(blocks.map((b) => b.kind)).toEqual(["toolGroup", "tool", "toolGroup"]);
    expect(blocks[0].tools.map((t) => t.id)).toEqual(["T1", "T2"]);
    expect(blocks[1].tool.id).toBe("S1");
    expect(blocks[2].tools.map((t) => t.id)).toEqual(["T3", "T4"]);
  });

  it("renders a standalone tool alone even between groupable tools from tool_running events", () => {
    const events = [
      { type: "tool_running", ts: 100, payload: { toolName: "Bash", toolUseId: "B1", input: {} } },
      { type: "tool_running", ts: 101, payload: { toolName: "AskUserQuestion", toolUseId: "Q1", input: {} } },
      { type: "tool_running", ts: 102, payload: { toolName: "Bash", toolUseId: "B2", input: {} } },
    ];
    const blocks = buildBlocks(events);
    expect(blocks.map((b) => b.kind)).toEqual(["tool", "tool", "tool"]);
    expect(blocks[1].tool.name).toBe("AskUserQuestion");
  });
});
