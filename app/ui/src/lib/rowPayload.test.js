import { describe, it, expect } from "vitest";
import { rowPayload } from "./toolLifecycle.js";
import { buildBlocks, applyClears, applyRewinds, applyRecalls, compactionStatus, splitAtCompaction } from "./messageParser.js";
import { collectSubagents, groupSubagentRuns } from "./subagentRuns.js";
import { collectArtifacts } from "./artifactLink.js";
import { stableGenuiIndex } from "../genui/runtime/conversation.js";
import { deriveTurns } from "./turnIndex.js";
import { blocksAcrossConversation } from "../hooks/useConversationBlocks.js";

// Rows as the server sends them: the payload is a JSON string.
let nextId = 0;
const row = (type, ts, payload) => ({ id: ++nextId, worker_id: "w1", type, ts, payload: JSON.stringify(payload) });
const agent = (ts, payload) => row("agent_event", ts, payload);

function deepFreeze(v) {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze(v[k]);
  }
  return v;
}

// One of every row shape the parse pipeline reads, nested inputs included.
function conversation() {
  return [
    row("user_message", 100, { text: "hello", clientMsgIds: ["c1"], replyTo: { role: "assistant", msgId: "m1", excerpt: "x" } }),
    agent(101, { type: "message", role: "assistant", blocks: [
      { type: "reasoning", text: "thinking" },
      { type: "text", text: "looking", blockId: "b1" },
      { type: "tool_call", callId: "T1", name: "TodoWrite", input: { todos: [{ content: "b", status: "pending" }, { content: "a", status: "done" }] } },
      { type: "tool_call", callId: "AG", name: "Agent", spawnsSubagent: true, input: { description: "dig", prompt: "find it", model: "sonnet" } },
      { type: "tool_call", callId: "AR", name: "Artifact", input: { file_path: "/tmp/report.html", title: "Report" } },
      { type: "tool_call", callId: "V1", name: "mcp__worker__present", input: { title: "Picks", data: { items: [{ n: 2 }, { n: 1 }] }, ui: "<List of=\"items\"/>", summary: "s" } },
      { type: "tool_call", callId: "WF", name: "Workflow", input: { script: "x" } },
    ] }),
    agent(102, { type: "message", role: "tool", blocks: [
      { type: "tool_result", callId: "T1", content: "ok" },
      { type: "tool_result", callId: "AR", content: "Published https://claude.ai/artifact/0f0e2bbc-7a3c-4d2e-9f00-5b8c3e4d1a2b" },
      { type: "tool_result", callId: "V1", content: "view v_abcdefghijkl rendered" },
      { type: "tool_result", callId: "E1", content: "edited", patch: { hunks: [{ lines: ["-a", "+b"] }] } },
    ] }),
    agent(103, { type: "subagent_started", callId: "AG", agentId: "ag-1" }),
    agent(104, { type: "subagent_profile", callId: "AG", model: "claude-haiku-4-5", effort: "high" }),
    agent(105, { type: "activity", kind: "tool_started", toolName: "Read", callId: "R1", input: { file_path: "/x", range: [1, 2] }, parentCallId: "AG" }),
    agent(106, { type: "activity", kind: "tool_finished", toolName: "Read", callId: "R1", result: "content" }),
    agent(107, { type: "subagent_completed", callId: "AG", status: "completed", result: "found", usage: { inputTokens: 5, outputTokens: 7 } }),
    agent(108, { type: "workflow_started", callId: "WF", runId: "r1" }),
    agent(109, { type: "workflow_completed", callId: "WF", status: "completed", progress: [{ phase: "one", agents: [{ id: "a1" }] }] }),
    agent(110, { type: "message", role: "assistant", blocks: [
      { type: "tool_call", callId: "Q1", name: "AskUserQuestion", input: { questions: [{ question: "Which?", options: [{ label: "A" }, { label: "B" }] }] } },
    ] }),
    row("user_message", 110, { text: "My answers to your questions: A" }),
    row("peer_request", 111, { text: "help?", fromWorker: "w2", fromName: "peer" }),
    row("state", 112, { state: "IDLE" }),
    agent(113, { type: "turn", phase: "error", reason: "auth_invalid" }),
    row("compaction_started", 114, { trigger: "auto" }),
    row("compaction_completed", 115, { trigger: "auto", summary: "so far", beforeTokens: 100, afterTokens: 10 }),
    row("user_message", 116, { text: "again", clientMsgIds: ["c2"], action: { viewId: "v_abcdefghijkl", actionId: "go", label: "Go" } }),
    row("message_recalled", 117, { recalledRowId: 9999, clientMsgId: "c9" }),
    row("conversation_rewound", 118, { text: "nothing matches", index: 99 }),
    row("lifecycle", 119, { phase: "interrupted" }),
  ];
}

describe("rowPayload", () => {
  it("parses a row once and hands every reader the same object", () => {
    const r = row("state", 1, { state: "IDLE" });
    expect(rowPayload(r)).toBe(rowPayload(r));
    expect(rowPayload(r)).toEqual({ state: "IDLE" });
  });

  it("parses a new row object anew (a patched row arrives as a new object)", () => {
    const r = row("state", 1, { state: "IDLE" });
    const patched = { ...r, payload: JSON.stringify({ state: "WORKING" }) };
    expect(rowPayload(r).state).toBe("IDLE");
    expect(rowPayload(patched).state).toBe("WORKING");
  });

  it("passes an object payload through and maps a broken one to {}", () => {
    const payload = { state: "IDLE" };
    expect(rowPayload({ type: "state", payload })).toBe(payload);
    expect(rowPayload({ type: "state", payload: "{nope" })).toEqual({});
    expect(rowPayload({ type: "state", payload: null })).toEqual({});
  });
});

// The parsed payloads are shared by every rebuild: the parse pipeline and the
// lists derived from its blocks must only read them. Frozen payloads make any
// write throw (ES modules run in strict mode).
describe("the parse pipeline treats parsed payloads as read-only", () => {
  it("builds the same blocks from frozen payloads, twice", () => {
    const rows = conversation();
    const before = rows.map((r) => r.payload);
    for (const r of rows) deepFreeze(rowPayload(r));

    const build = () => {
      const blocks = buildBlocks(applyRecalls(applyRewinds(applyClears(rows), { bootPromptOffset: 0 })));
      const subagents = collectSubagents(blocks);
      return {
        blocks,
        subagents,
        grouped: groupSubagentRuns(blocks, subagents),
        artifacts: collectArtifacts(blocks),
        genui: stableGenuiIndex(blocks, null),
        turns: deriveTurns(blocks, (b, i) => i),
        compaction: compactionStatus(rows),
        split: splitAtCompaction(rows),
        across: blocksAcrossConversation(rows.slice(0, 10), rows.slice(10), 0),
      };
    };
    const first = build();
    const second = build();

    expect(second).toEqual(first);
    expect(first.subagents.map((s) => [s.toolUseId, s.status, s.model])).toEqual([["AG", "completed", "claude-haiku-4-5"]]);
    expect(first.subagents[0].tools.map((t) => t.id)).toEqual(["R1"]);
    expect(first.artifacts).toHaveLength(1);
    expect(first.blocks.find((b) => b.kind === "tool" && b.tool.name === "AskUserQuestion").tool.result.text).toMatch(/^My answers/);
    expect(first.blocks.some((b) => b.kind === "workflow" && b.completed?.status === "completed")).toBe(true);
    expect(rows.map((r) => r.payload)).toEqual(before);
  });
});
